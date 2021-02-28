'use strict'
const {
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLString,
  GraphQLBoolean,
  GraphQLList,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLID
} = require('graphql')

const { GraphQLJSON } = require('graphql-type-json')
const { attributeFields, resolver, typeMapper } = require('graphql-sequelize')
const pluralize = require('pluralize')
const DataTypes = require('sequelize/lib/data-types')

const {
  beforeResolver,
  getRequestedAttributes,
  loggerFactory,
  nameFormatterFactory,
  findOptionsMerger,
  attributeInputFields,
  attributeUpdateFields,
  getNestedInputIncludes,
  cleanWhereQuery
} = require('./lib/utils.js')

typeMapper.mapType((type) => {
  if (type instanceof DataTypes.BLOB) {
    return GraphQLString
  }
  return false
})

const sequelizeToGraphQLSchemaBuilder = (sequelize, {
  namespace = '',
  extraModelFields = () => ({}),
  extraModelQueries = () => ({}),
  extraModelTypes = () => ({}),
  debug = false,
  maxManyAssociations = 3,
  extraModelMutations = () => ({}),
  nameFormatter = null
}) => {
  let queries = {}
  let mutations = {}
  const typesCache = {}
  const modelsTypes = {}
  nameFormatter = nameFormatter ?? nameFormatterFactory(namespace)
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
      const fieldName = nameFormatter.modelToFieldName(isMany ? pluralize(association.as) : association.as, association.as)

      logger.log('sequelizeToGraphQLSchemaBuilder', {
        modelName: model.name,
        associationType: association.associationType,
        associationAs: association.as,
        associationTargetName: association.target.name
      })

      associationFields[fieldName] = () => ({
        type: isMany
          ? new GraphQLList(modelsTypes[nameFormatter.formatTypeName(association.target.name)])
          : modelsTypes[nameFormatter.formatTypeName(association.target.name)],
        args: {
          query: { type: GraphQLJSON },
          required: { type: GraphQLBoolean }
        },
        resolve: resolver(association, {
          before: beforeResolver(association.target, { nameFormatter, logger, maxManyAssociations })
        })
      })
    }

    // Add to base model type : its own field and association fields as post computable fields
    // to avoid circular dependances
    const rawFields = attributeFields(model, { cache: typesCache })
    console.log(model.primaryKeys)
    const associationsFk = new Set(Object.values(model.associations)
      .filter(({ associationType }) => associationType === 'BelongsTo')
      .map(({ options: { foreignKey } }) => foreignKey.name ?? foreignKey))
    for (const field in rawFields) {
      console.log(field)
      if (model.rawAttributes[field].primaryKey || associationsFk.has(field))
      rawFields[field].type = rawFields[field].type instanceof GraphQLNonNull
        ? new GraphQLNonNull(GraphQLID)
        : GraphQLID
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
    const associationInputFields = {}
    for (const associationName in model.associations) {
      const association = model.associations[associationName]
      const isMany = ['HasMany', 'BelongsToMany'].includes(association.associationType)
      const fieldName = nameFormatter.modelToFieldName(isMany ? pluralize(association.as) : association.as, association.as)

      associationInputFields[fieldName] = () => ({
        type: isMany
          ? new GraphQLList(modelsTypes[nameFormatter.formatInsertInputTypeName(association.target.name)])
          : modelsTypes[nameFormatter.formatInsertInputTypeName(association.target.name)]
      })
    }

    const modelInsertInputType = new GraphQLInputObjectType({
      name: nameFormatter.formatInsertInputTypeName(modelName),
      description: `${modelName} insert input type`,
      fields: () => ({
        ...attributeInputFields(model, { cache: typesCache, nameFormatter }),
        // ...extraModelFields({ modelsTypes, nameFormatter, logger }, model)
        ...Object.keys(associationInputFields).reduce((o, associationField) => {
          o[associationField] = associationInputFields[associationField]()
          return o
        }, {})
      })
    })

    const modelUpdateInputType = new GraphQLInputObjectType({
      name: nameFormatter.formatUpdateInputTypeName(modelName),
      description: `${modelName} update input type`,
      fields: () => attributeUpdateFields(model, { cache: typesCache })
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

    // Root models query
    const manyQueryName = nameFormatter.formatManyQueryName(modelName)
    queries[manyQueryName] = {
      // The resolver will use `findOne` or `findAll` depending on whether the field it's used in is a `GraphQLList` or not.
      type: new GraphQLList(modelType),
      args: {
        query: { type: GraphQLJSON },
        required: { type: GraphQLBoolean }
      },
      resolve: resolver(model, {
        before: async ({ attributes, ...otherFindOptions }, args, ctx, infos, ...rest) => {
          logger.log('root query resolver', {
            manyQueryName,
            attributes
          })

          const findOptions = await beforeResolver(model, { nameFormatter, logger, maxManyAssociations })({
            ...otherFindOptions,
            attributes: getRequestedAttributes(model, infos.fieldNodes[0], logger)
          }, args, ctx, infos, ...rest)

          logger.log('root query resolver', {
            manyQueryName,
            finalFindOptionsAttributes: findOptions.attributes,
            finalFindOptionsInclude: findOptions.include
          })

          return findOptions
        }
      })
    }

    const insertMutationName = nameFormatter.formatInsertMutationName(modelName)
    mutations[insertMutationName] = {
      type: modelType,
      args: {
        input: { type: modelInsertInputType }
      },
      resolve: (parent, { input }) => {
        // return model.create(input)
        const [sequelizeInput, include] = getNestedInputIncludes(input, model, modelInsertInputType, nameFormatter)
        return model.create(sequelizeInput, { include })
      }
    }

    const deleteMutationName = nameFormatter.formatDeleteMutationName(modelName)
    mutations[deleteMutationName] = {
      type: new GraphQLNonNull(GraphQLInt),
      args: {
        query: { type: GraphQLJSON }
      },
      resolve: (parent, { query }) => {
        if (!query.where) {
          throw Error('You must define a where clause when deleting')
        }
        return model.destroy({ where: cleanWhereQuery(model, query.where) })
      }
    }

    const updateMutationName = nameFormatter.formatUpdateMutationName(modelName)
    mutations[updateMutationName] = {
      type: new GraphQLNonNull(GraphQLInt),
      args: {
        query: { type: GraphQLJSON },
        input: { type: modelUpdateInputType }
      },
      resolve: async (parent, { query, input }) => {
        if (!query.where) {
          throw Error('You must define a where clause when updating')
        }
        let count = 0
        for (const instance of await model.findAll({ where: cleanWhereQuery(model, query.where) })) {
          for (const field in input) {
            instance[field] = input[field]
          }
          instance.save()
          count += 1
        }
        return count
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
  sequelizeToGraphQLSchemaBuilder,
  getRequestedAttributes,
  beforeResolver,
  findOptionsMerger,
  nameFormatterFactory,
  loggerFactory
}
