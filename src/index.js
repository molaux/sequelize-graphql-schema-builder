'use strict'
const {
  GraphQLString
} = require('graphql')

const { typeMapper } = require('graphql-sequelize')
const DataTypes = require('sequelize/lib/data-types')
const {
  beforeResolverFactory,
  beforeModelResolverFactory,
  beforeAssociationResolverFactory
} = require('./lib/resolvers.js')

const {
  loggerFactory
} = require('./lib/logger.js')

const {
  getRequestedAttributes,
  resolveFragments
} = require('./lib/graphql.js')

const {
  findOptionsMerger
} = require('./lib/sequelize.js')

const {
  nameFormatterFactory
} = require('./lib/nameFormatter.js')

const {
  builder: typesBuilder
} = require('./lib/types')

const {
  builder: queriesBuilder,
  manyResolverFactory
} = require('./lib/queries')

const {
  builder: mutationsBuilder
} = require('./lib/mutations')

const {
  builder: subscriptionsBuilder
} = require('./lib/subscriptions')

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

  const modelsTypes = {}
  let queries = {}
  let mutations = {}
  let subscriptions = {}
  const typesCache = {}
  const nameFormatter = defaultNameFormatter ?? nameFormatterFactory(namespace)
  const logger = loggerFactory(debug)
  const typesNameSet = new Set()

  // Generate each model schema and resolver
  for (const modelName in sequelize.models) {
    const model = sequelize.models[modelName]

    const {
      modelTypes,
      modelType,
      modelValidatorType,
      modelIDType,
      modelInsertInputType,
      modelUpdateInputType
    } = typesBuilder(model, modelsTypes, typesCache, extraModelFields, { nameFormatter, logger, maxManyAssociations })

    for (const modelTypeName in modelTypes) {
      const modelType = modelTypes[modelTypeName]
      // Manage association fileds resolvers
      if (typesNameSet.has(modelType.name)) {
        throw Error(`${model.name} -> modelTypes already contains a type named ${modelType.name}`)
      }

      modelsTypes[modelTypeName] = modelType
      typesNameSet.add(modelType.name)
    }

    const extraTypes = extraModelTypes({ modelsTypes, nameFormatter, logger }, model)

    for (const extraTypeName in extraTypes) {
      if (typesNameSet.has(extraTypes[extraTypeName].name)) {
        throw Error(`extraModelTypes(..., ${model.name}) -> modelTypes already contains a type named ${extraTypes[extraTypeName].name}`)
      }
      modelsTypes[extraTypeName] = extraTypes[extraTypeName]
      typesNameSet.add(extraTypes[extraTypeName].name)
    }

    // Root models query
    const manyResolver = manyResolverFactory(model, { nameFormatter, logger, maxManyAssociations })

    queries = {
      ...queries,
      ...queriesBuilder(model, modelType, modelValidatorType, manyResolver, { nameFormatter }),
      ...extraModelQueries({ modelsTypes, nameFormatter, logger }, model, queries)
    }

    mutations = {
      ...mutations,
      ...mutationsBuilder(model, modelType, modelInsertInputType, modelUpdateInputType, manyResolver, sequelize, { nameFormatter, logger }),
      ...extraModelMutations({ modelsTypes, nameFormatter, logger }, model, mutations)
    }

    subscriptions = {
      ...subscriptions,
      ...subscriptionsBuilder(model, modelType, modelIDType, manyResolver, { nameFormatter })
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
  beforeAssociationResolverFactory,
  resolveFragments
}
