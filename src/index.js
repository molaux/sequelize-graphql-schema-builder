'use strict'
const {
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLString,
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
  GraphQLID
} = require('graphql')

const { GraphQLJSON } = require('graphql-type-json')
const { attributeFields, resolver, typeMapper } = require('graphql-sequelize')
const pluralize = require('pluralize')
const DataTypes = require('sequelize/lib/data-types')
const {
  beforeResolverFactory,
  beforeModelResolverFactory,
  beforeAssociationResolverFactory
} = require('./lib/resolvers.js')

const { cleanWhereQuery } = require('./lib/query.js')

const {
  loggerFactory
} = require('./lib/logger.js')

const {
  getInsertInputFields,
  getUpdateInputFields,
  getRequestedAttributes
} = require('./lib/graphql.js')

const {
  getNestedInputs,
  findOptionsMerger
} = require('./lib/sequelize.js')

const {
  nameFormatterFactory
} = require('./lib/nameFormatter.js')

const {
  InputModelAssociationType
} = require('./lib/InputModelAssociationType')

const {
  InputModelIDTypeFactory
} = require('./lib/InputModelIDType')

typeMapper.mapType((type) => {
  if (type instanceof DataTypes.BLOB) {
    return GraphQLString
  }
  return false
})

const schemaBuilder = (sequelize, options) => {
  const {
    namespace,
    extraModelFields,
    extraModelQueries,
    extraModelTypes,
    debug,
    maxManyAssociations,
    extraModelMutations,
    nameFormatter: defaultNameFormatter
  } = Object.assign({}, {
    namespace: '',
    extraModelTypes: () => ({}),
    extraModelFields: () => ({}),
    extraModelQueries: () => ({}),
    extraModelMutations: () => ({}),
    debug: false,
    maxManyAssociations: 3,
    nameFormatter: null
  }, options)

  let queries = {}
  let mutations = {}
  const typesCache = {}
  const modelsTypes = {}
  const nameFormatter = defaultNameFormatter ?? nameFormatterFactory(namespace)
  const logger = loggerFactory(debug)
  const typesNameSet = new Set()

  // Generate each model schema and resolver
  for (const modelName in sequelize.models) {
    const model = sequelize.models[modelName]

    // Manage association fileds resolvers
    const associationFields = {}
    for (const associationName in model.associations) {
      const association = model.associations[associationName]
      // Add assotiation fields to request and get it post computed to avoid circular dependance
      const isMany = ['HasMany', 'BelongsToMany'].includes(association.associationType)
      const fieldName = nameFormatter.modelNameToFieldName(isMany ? pluralize(association.as) : association.as, association.as)

      logger.log('sequelizeToGraphQLSchemaBuilder', {
        modelName: model.name,
        associationType: association.associationType,
        associationAs: association.as,
        associationTargetName: association.target.name
      })

      // Object.defineProperty(model, fieldName, { get: () => model[association.accessors.get]() })

      associationFields[fieldName] = () => ({
        type: isMany
          ? new GraphQLList(modelsTypes[nameFormatter.formatTypeName(association.target.name)])
          : modelsTypes[nameFormatter.formatTypeName(association.target.name)],
        args: {
          query: { type: GraphQLJSON },
          optimized: { type: GraphQLBoolean }
        },
        resolve: (...args) => resolver(association, {
          before: beforeResolverFactory(association.target, { nameFormatter, logger, maxManyAssociations })
        })(...args)
      })
    }

    // Add to base model type : its own field and association fields as post computable fields
    // to avoid circular dependancies

    const rawFields = attributeFields(model, { cache: typesCache })
    const associationsFk = new Set(Object.values(model.associations)
      .filter(({ associationType }) => associationType === 'BelongsTo')
      .map(({ options: { foreignKey } }) => foreignKey.name ?? foreignKey))
    for (const field in rawFields) {
      if (model.rawAttributes[field].primaryKey || associationsFk.has(field)) {
        rawFields[field].type = rawFields[field].type instanceof GraphQLNonNull
          ? new GraphQLNonNull(GraphQLID)
          : GraphQLID
      }
    }

    const modelType = new GraphQLObjectType({
      name: nameFormatter.formatTypeName(modelName),
      description: `${modelName} type`,
      fields: () => ({
        ...rawFields,
        ...extraModelFields({ modelsTypes, nameFormatter, logger }, model),
        ...Object.keys(associationFields).reduce((o, associationField) => {
          o[associationField] = associationFields[associationField]()
          return o
        }, {})
      })
    })

    // Input types
    const associationInsertInputFields = {}
    const associationRemovableModelIDInputFields = {}
    for (const associationName in model.associations) {
      const association = model.associations[associationName]
      const isMany = ['HasMany', 'BelongsToMany'].includes(association.associationType)
      const fieldName = nameFormatter.modelNameToFieldName(isMany ? pluralize(association.as) : association.as, association.as)
      associationInsertInputFields[fieldName] = () => ({
        type: isMany
          ? new GraphQLList(new InputModelAssociationType(association, modelsTypes[nameFormatter.formatInsertInputTypeName(association.target.name)]))
          : new InputModelAssociationType(association, modelsTypes[nameFormatter.formatInsertInputTypeName(association.target.name)])
      })
      if (association.associationType === 'BelongsToMany') {
        // Association can be removed from this side
        associationRemovableModelIDInputFields[fieldName] = () => ({
          type: new GraphQLList(new InputModelIDTypeFactory(association))
        })
      }
    }

    const modelInsertInputType = new GraphQLInputObjectType({
      name: nameFormatter.formatInsertInputTypeName(modelName),
      description: `${modelName} insert input type`,
      fields: () => ({
        ...getInsertInputFields(model, { cache: typesCache, nameFormatter }),
        // ...extraModelFields({ modelsTypes, nameFormatter, logger }, model)
        ...Object.keys(associationInsertInputFields).reduce((o, associationField) => {
          o[associationField] = associationInsertInputFields[associationField]()
          return o
        }, {})
      })
    })

    const modelUpdateInputType = new GraphQLInputObjectType({
      name: nameFormatter.formatUpdateInputTypeName(modelName),
      description: `${modelName} update input type`,
      fields: () => ({
        ...getUpdateInputFields(model, { cache: typesCache }),
        ...Object.keys(associationInsertInputFields).reduce((o, associationField) => {
          o[associationField] = associationInsertInputFields[associationField]()
          if (o[associationField].type instanceof GraphQLList) {
            o[`add${associationField}`] = associationInsertInputFields[associationField]()
            if (associationRemovableModelIDInputFields[associationField] !== undefined) {
              o[`remove${associationField}`] = associationRemovableModelIDInputFields[associationField]()
            }
          }
          return o
        }, {})
      })
    })

    if (typesNameSet.has(modelType.name)) {
      throw Error(`${model.name} -> modelsTypes already contains a type named ${modelType.name}`)
    }
    typesNameSet.add(modelType.name)

    if (typesNameSet.has(modelInsertInputType.name)) {
      throw Error(`${model.name} -> modelsTypes already contains an input type named ${modelInsertInputType.name}`)
    }
    typesNameSet.add(modelInsertInputType.name)

    if (typesNameSet.has(modelUpdateInputType.name)) {
      throw Error(`${model.name} -> modelsTypes already contains an input type named ${modelUpdateInputType.name}`)
    }
    typesNameSet.add(modelUpdateInputType.name)

    // keep a trace of models to reuse in associations
    modelsTypes[nameFormatter.formatTypeName(modelName)] = modelType
    modelsTypes[nameFormatter.formatInsertInputTypeName(modelName)] = modelInsertInputType
    modelsTypes[nameFormatter.formatUpdateInputTypeName(modelName)] = modelUpdateInputType

    const extraTypes = extraModelTypes({ modelsTypes, nameFormatter, logger }, model)

    for (const extraTypeName in extraTypes) {
      if (typesNameSet.has(extraTypes[extraTypeName].name)) {
        throw Error(`extraModelTypes(..., ${model.name}) -> modelsTypes already contains a type named ${extraTypes[extraTypeName].name}`)
      }
      modelsTypes[extraTypeName] = extraTypes[extraTypeName]
      typesNameSet.add(extraTypes[extraTypeName].name)
    }

    const manyResolver = async (parent, args, ...rest) => {
      const resolved = await resolver(model, {
        before: async ({ attributes, ...otherFindOptions }, args, ctx, infos, ...rest) => {
          logger.log('manyResolver', {
            manyQueryName,
            attributes
          })

          const findOptions = await beforeResolverFactory(model, { nameFormatter, logger, maxManyAssociations })({
            ...otherFindOptions,
            attributes: getRequestedAttributes(model, infos.fieldNodes[0], logger)
          }, args, ctx, infos, ...rest)

          logger.log('manyResolver', {
            manyQueryName,
            finalFindOptionsAttributes: findOptions.attributes,
            finalFindOptionsInclude: findOptions.include
          })
          return findOptions
        }
      })(parent, args, ...rest)
      logger.log('manyResolver', {
        manyQueryName,
        resolved
      })
      return resolved
    }

    // Root models query
    const manyQueryName = nameFormatter.formatManyQueryName(modelName)
    queries[manyQueryName] = {
      // The resolver will use `findOne` or `findAll` depending on whether the field it's used in is a `GraphQLList` or not.
      type: new GraphQLList(modelType),
      args: {
        query: { type: GraphQLJSON },
        optimized: { type: GraphQLBoolean }
      },
      resolve: manyResolver
    }

    const deleteMutationName = nameFormatter.formatDeleteMutationName(modelName)
    mutations[deleteMutationName] = {
      type: new GraphQLList(modelType),
      args: {
        query: { type: GraphQLJSON }
      },
      resolve: async (parent, { query }, ...rest) => {
        if (!query.where) {
          throw Error('You must define a where clause when deleting')
        }
        const models = await manyResolver(parent, { query }, ...rest)
        model.destroy({ where: cleanWhereQuery(model, query.where) })
        return models
      }
    }

    const insertMutationName = nameFormatter.formatInsertMutationName(modelName)
    mutations[insertMutationName] = {
      type: modelType,
      args: {
        input: { type: modelInsertInputType }
      },
      resolve: async (parent, { input }, ...rest) => {
        const { sequelizeInput, includes: include, foreignHooks } = getNestedInputs(input, model, modelInsertInputType, { nameFormatter, logger })
        const createdModel = await model.create(sequelizeInput, { include })
        await Promise.all(foreignHooks.map(hook => hook(createdModel)))
        return manyResolver(parent, {
          query: {
            where: {
              [model.primaryKeyAttribute]: createdModel[model.primaryKeyAttribute]
            }
          }
        }, ...rest)
      }
    }

    const updateMutationName = nameFormatter.formatUpdateMutationName(modelName)
    mutations[updateMutationName] = {
      type: new GraphQLList(modelType),
      args: {
        query: { type: GraphQLJSON },
        input: { type: modelUpdateInputType }
      },
      resolve: async (parent, { query, input }, ...rest) => {
        if (!query.where) {
          throw Error('You must define a where clause when updating')
        }

        // sequelizeInput and includes ave to be be divised by Pks.
        // Then, foreign hooks have to be remerged
        // with resulting bulk created entities
        const localHooks = {}
        const foreignKeysInput = {}
        for (const rawField in input) {
          // test if field is a many modifier
          const matches = rawField.match(/^(?<action>add|remove)(?<field>.+)$/)
          const action = matches?.groups?.action ?? 'set'
          const field = matches?.groups?.field ?? rawField

          if (field in associationInsertInputFields && action !== 'remove') {
            const foreignModelName = nameFormatter.fieldNameToModelName(field)
            const foreignModel = model.associations[foreignModelName].target
            const foreignModelNameAs = model.associations[foreignModelName].as
            const {
              sequelizeInput: foreignSequelizeInput,
              includes: foreignIncludes,
              foreignHooks: foreignForeignHooks
            } = getNestedInputs(
              { [field]: input[rawField] }, // mock input as if it was the only field
              model,
              modelInsertInputType,
              { nameFormatter, logger }
            )

            const foreignKey = model.associations[foreignModelName].foreignKey.name ?? model.associations[foreignModelName].foreignKey
            // foreign(s) creation
            const sequelizeInputs = foreignSequelizeInput[foreignModelNameAs] !== undefined
              ? Array.isArray(foreignSequelizeInput[foreignModelNameAs])
                ? foreignSequelizeInput[foreignModelNameAs]
                : [foreignSequelizeInput[foreignModelNameAs]]
              : []
            // single foreign reference
            const foreignKeyValue = !Array.isArray(foreignSequelizeInput[foreignModelNameAs]) && foreignSequelizeInput[foreignKey]
              ? foreignSequelizeInput[foreignKey]
              : undefined
            if (foreignKeyValue !== undefined) {
              foreignKeysInput[foreignKey] = foreignKeyValue
            } else {
              if ((!foreignForeignHooks.length && !sequelizeInputs.length)) {
                console.log(foreignForeignHooks, sequelizeInputs)
                throw Error(`Error, something unexpected happened with ${model.name} -> ${foreignModelName} (through ${field} by ${foreignKey})`)
              }

              const include = sequelizeInputs.length
                ? foreignIncludes[foreignModelName]
                : null

              const createdModels = sequelizeInputs.map((sequelizeInput) => foreignModel.create(sequelizeInput, { ...include }))
              localHooks[field] = async (instance) => {
                for (const foreignForeignHook of foreignForeignHooks) {
                  await foreignForeignHook(instance, 'add')
                }
                return instance[model.associations[foreignModelName].accessors[
                  Array.isArray(foreignSequelizeInput[foreignModelNameAs]) ? 'add' : 'set']
                ](Array.isArray(foreignSequelizeInput[foreignModelNameAs])
                  ? await Promise.all(createdModels)
                  : (await Promise.all(createdModels))[0]
                )
              }
            }
          }
        }

        const models = []
        const hooks = []

        for (const instance of await model.findAll({ where: cleanWhereQuery(model, query.where) })) {
          for (const rawField in input) {
            const matches = rawField.match(/^(?<action>add|remove)(?<field>.+)$/)
            const action = matches?.groups?.action ?? 'set'
            const field = matches?.groups?.field ?? rawField

            if (action !== 'remove') {
              if (field in associationInsertInputFields) {
                const foreignModelName = nameFormatter.fieldNameToModelName(field)
                const foreignModelNameAs = model.associations[foreignModelName].as
                const foreignKey = model.associations[foreignModelNameAs].foreignKey.name ?? model.associations[foreignModelNameAs].foreignKey
                if (!Array.isArray(input[rawField]) && foreignKeysInput[foreignKey] !== undefined) {
                  instance[foreignKey] = foreignKeysInput[foreignKey]
                } else {
                  hooks.push(async () => {
                    if (Array.isArray(input[rawField]) && action === 'set') {
                      const foreignModelName = nameFormatter.fieldNameToModelName(field)
                      await instance[model.associations[foreignModelName].accessors.set]([])
                    }
                    await localHooks[field](instance)
                  })
                }
              } else {
                instance[field] = input[rawField]
              }
            } else {
              const foreignModelName = nameFormatter.fieldNameToModelName(field)
              const realFk = Object.keys(model.associations[foreignModelName].target.primaryKeys)[0]
              hooks.push(() => instance[model.associations[foreignModelName].accessors.remove](
                input[rawField].map(oid => oid[realFk])
              ))
            }
          }
          models.push(instance)
        }

        await Promise.all(models)
        await Promise.all(hooks.map(hook => hook()))

        return manyResolver(parent, { query }, ...rest)
      }
    }

    queries = {
      ...queries,
      ...extraModelQueries({ modelsTypes, nameFormatter, logger }, model, queries)
    }

    mutations = {
      ...mutations,
      ...extraModelMutations({ modelsTypes, nameFormatter, logger }, model, mutations)
    }
  }

  const extraTypes = extraModelTypes({ modelsTypes, nameFormatter, logger }, undefined)

  for (const extraTypeName in extraTypes) {
    if (typesNameSet.has(extraTypes[extraTypeName].name)) {
      throw Error(`extraModelTypes(..., null) -> modelsTypes already contains a type named ${extraTypes[extraTypeName].name}`)
    }
    modelsTypes[extraTypeName] = extraTypes[extraTypeName]
    typesNameSet.add(extraTypes[extraTypeName].name)
  }

  queries = {
    ...queries,
    ...extraModelQueries({ modelsTypes, nameFormatter, logger }, undefined, queries)
  }

  mutations = {
    ...mutations,
    ...extraModelMutations({ modelsTypes, nameFormatter, logger }, undefined, mutations)
  }

  return {
    modelsTypes,
    queries,
    mutations,
    logger,
    nameFormatter
  }
}

module.exports = {
  schemaBuilder,
  getRequestedAttributes,
  beforeResolverFactory,
  findOptionsMerger,
  nameFormatterFactory,
  loggerFactory,
  beforeModelResolverFactory,
  beforeAssociationResolverFactory
}
