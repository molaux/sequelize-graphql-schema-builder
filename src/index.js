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

const { withFilter } = require('graphql-subscriptions')

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
  inputResolver,
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
  const subscriptions = {}
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
          dissociate: { type: GraphQLBoolean }
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

    const modelIDType = new GraphQLObjectType({
      name: `${nameFormatter.formatTypeName(modelName)}ID`,
      description: `${modelName} ID type`,
      fields: () => ({
        [model.primaryKeyAttribute]: {
          type: GraphQLID
        }
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
            finalFindOptionsInclude: findOptions.include,
            finalFindOptionsWhere: findOptions.where
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
        query: { type: GraphQLJSON }
      },
      resolve: manyResolver
    }

    const deleteMutationName = nameFormatter.formatDeleteMutationName(modelName)
    mutations[deleteMutationName] = {
      type: new GraphQLList(modelType),
      args: {
        query: { type: GraphQLJSON }
      },
      resolve: async (parent, { query }, { pubSub, ...ctx }, ...rest) => {
        if (!query.where) {
          throw Error('You must define a where clause when deleting')
        }
        const models = await manyResolver(parent, { query }, { pubSub, ...ctx }, ...rest)
        pubSub?.publish('modelsDeleted', models)

        // TODO: consider foreigns oneToMany cascade set NULL or delete

        model.destroy({ where: cleanWhereQuery(model, query.where) })
        return models
      }
    }

    const AccumulatorPubSub = function () {
      this.register = []
      return {
        publish: (event, payload) => {
          this.register.push({ event, payload })
          console.log(this.register)
        },
        flushTo: (pubSub) => {
          const payloads = {}
          for (const { event, payload } of this.register) {
            if (!payloads[event]) {
              payloads[event] = []
            }
            payloads[event].push(payload)
          }
          for (const event in payloads) {
            pubSub.publish(event, payloads[event])
          }
        }
      }
    }

    const insertMutationName = nameFormatter.formatInsertMutationName(modelName)
    mutations[insertMutationName] = {
      type: modelType,
      args: {
        input: { type: modelInsertInputType }
      },
      resolve: async (parent, { input }, { pubSub, ...ctx }, ...rest) => {
        const accumulatorPubSub = pubSub
          ? new AccumulatorPubSub()
          : null
        const { sequelizeInput, resolvers } = await inputResolver(input, model, modelInsertInputType, { nameFormatter, logger, pubSub: accumulatorPubSub })
        const instance = await model.create(sequelizeInput)

        await Promise.all(resolvers.map(r => r(instance, 'set')))

        accumulatorPubSub?.publish('modelsCreated', { model, instances: [instance] })
        accumulatorPubSub?.flushTo(pubSub)

        return manyResolver(parent, {
          query: {
            where: {
              [model.primaryKeyAttribute]: instance[model.primaryKeyAttribute]
            }
          }
        }, { pubSub, ...ctx }, ...rest)
      }
    }

    const updateMutationName = nameFormatter.formatUpdateMutationName(modelName)
    mutations[updateMutationName] = {
      type: new GraphQLList(modelType),
      args: {
        query: { type: GraphQLJSON },
        input: { type: modelUpdateInputType }
      },
      resolve: async (parent, { query, input }, { pubSub, ...ctx }, ...rest) => {
        if (!query.where) {
          throw Error('You must define a where clause when updating')
        }

        const accumulatorPubSub = pubSub
          ? new AccumulatorPubSub()
          : null

        const setInput = {}
        const addInput = {}
        const removeInput = {}
        for (const rawField in input) {
          const matches = rawField.match(/^(?<action>add|remove)(?<field>.+)$/)
          const action = matches?.groups?.action ?? 'set'
          const field = matches?.groups?.field ?? rawField
          if (action === 'set') {
            setInput[field] = input[rawField]
          } else if (action === 'add') {
            addInput[field] = input[rawField]
          } else if (action === 'remove') {
            removeInput[field] = input[rawField]
          }
        }

        const {
          sequelizeInput: sequelizeSetInput,
          resolvers: setResolvers
        } = await inputResolver(setInput, model, modelInsertInputType, { nameFormatter, logger, pubSub: accumulatorPubSub })

        const {
          sequelizeInput: sequelizeAddInput,
          resolvers: addResolvers
        } = await inputResolver(addInput, model, modelInsertInputType, { nameFormatter, logger, pubSub: accumulatorPubSub })

        if (Object.keys(sequelizeAddInput).length) {
          throw Error('add association should not generate input')
        }

        const instances = []

        // retrieve instances targeted by query
        for (const instance of await model.findAll({ where: cleanWhereQuery(model, query.where) })) {
          for (const field in sequelizeSetInput) {
            // TODO : check if it's really updated
            instance[field] = sequelizeSetInput[field]
            console.log(field, sequelizeSetInput[field])
          }

          const removals = []
          for (const removeField in removeInput) {
            const foreignModelName = nameFormatter.fieldNameToModelName(removeField)
            const realFk = model.associations[foreignModelName].target.primaryKeyAttribute
            accumulatorPubSub?.publish('modelsRemoved', {
              model: model.associations[foreignModelName].target,
              ids: removeInput[removeField].map(oid => oid[realFk])
            })
            removals.push(instance[model.associations[foreignModelName].accessors.remove](
              removeInput[removeField].map(oid => oid[realFk])
            ))
          }
          await Promise.all([
            ...setResolvers.map((r) => r(instance, 'set')),
            ...addResolvers.map((r) => r(instance, 'add')),
            ...removals
          ])

          instances.push(instance)
        }

        await Promise.all(instances.map(instance => instance.save()))

        accumulatorPubSub?.publish('modelsUpdated', { model, instances })
        accumulatorPubSub?.flushTo(pubSub)

        return manyResolver(parent, { query }, { pubSub, ...ctx }, ...rest)
      }
    }

    const payloadsReducer = (payloads) => Array.from(payloads
      // filter payloads by model
      .filter(({ model: { name: payloadModelName } }) => payloadModelName === model.name)
      // resolve instances
      .map(({ ids, instances }) => ([
        ...ids ?? [],
        ...instances ? instances.map((instance) => instance[model.primaryKeyAttribute]) : []
      ]))
      // unicity
      .reduce((set, ids) => ids.reduce((set, id) => set.add(id), set), new Set())
      .values())

    const instancesResolver = (payloads, args, ...rest) => {
      if (payloads.length) {
        return manyResolver(
          null,
          {
            query: {
              where: {
                [model.primaryKeyAttribute]: {
                  _inOp: payloadsReducer(payloads)
                }
              }
            }
          },
          ...rest)
      } else {
        return []
      }
    }

    const subscribeToModelInstances = (action) => (payload, args, { pubSub, ...ctx }, ...rest) => withFilter(
      () => pubSub.asyncIterator(action),
      (payloads) => payloads.reduce(
        (keep, { model: { name: payloadModelName } }) => keep || payloadModelName === model.name,
        false
      )
    )(payload, args, { pubSub, ...ctx }, ...rest)

    const createdModelSubscriptionName = nameFormatter.formatCreatedSubscriptionName(modelName)
    subscriptions[createdModelSubscriptionName] = {
      type: new GraphQLList(modelType),
      subscribe: subscribeToModelInstances('modelsCreated'),
      resolve: instancesResolver
    }

    const updatedModelSubscriptionName = nameFormatter.formatUpdatedSubscriptionName(modelName)
    subscriptions[updatedModelSubscriptionName] = {
      type: new GraphQLList(modelType),
      subscribe: subscribeToModelInstances('modelsUpdated'),
      resolve: instancesResolver
    }

    const deletedModelSubscriptionName = nameFormatter.formatDeletedSubscriptionName(modelName)
    subscriptions[deletedModelSubscriptionName] = {
      type: new GraphQLList(modelIDType),
      subscribe: subscribeToModelInstances('modelsDeleted'),
      resolve: (payloads) => payloadsReducer(payloads).map((id) => ({ [model.primaryKeyAttribute]: id }))
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
    subscriptions,
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
