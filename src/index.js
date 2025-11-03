'use strict'
import {
  GraphQLString,
  GraphQLScalarType,
  GraphQLFloat
} from 'graphql'

import { DataTypes } from 'sequelize'

import { cleanWhereQuery } from './lib/query.js'
import {
  findOptionsMerger,
  includesMerger,
  beforeResolverFactory,
  beforeModelResolverFactory,
  beforeAssociationResolverFactory
} from './lib/resolvers.js'

import {
  loggerFactory
} from './lib/logger.js'

import {
  getRequestedAttributes,
  resolveFragments
} from './lib/graphql.js'

import {
  nameFormatterFactory
} from './lib/nameFormatter.js'

import {
  builder as typesBuilder
} from './lib/types.js'

import {
  builder as queriesBuilder,
  manyResolverFactory,
  countResolverFactory
} from './lib/queries.js'

import {
  builder as mutationsBuilder
} from './lib/mutations.js'

import {
  builder as subscriptionsBuilder
} from './lib/subscriptions.js'

import graphQLSequelizePkg from 'graphql-sequelize'
const { typeMapper } = graphQLSequelizePkg

function fromISODate (value) {
  try {
    if (!value) return null
    return new Date(value)
  } catch (e) {
    return null
  }
}

function toISODate (d) {
  if (!d) return null
  if ((d instanceof Date)) {
    return d.toISOString()
  }
  return d
}

const GraphQLDateOnly = new GraphQLScalarType({
  name: 'DateOnly',
  description: 'A special custom Scalar type for Dates that converts to a ISO formatted string ',
  serialize: toISODate,
  parseValue: fromISODate,
  parseLiteral (ast) {
    return new Date(ast.value)
  }
})

typeMapper.mapType((type) => {
  if (type instanceof DataTypes.DATEONLY) {
    return GraphQLDateOnly
  } else if (type instanceof DataTypes.BLOB) {
    return GraphQLString
  } else if (type instanceof DataTypes.DECIMAL) {
    return GraphQLFloat
  }
  return null
})

const schemaBuilder = (sequelize, options) => {
  const {
    namespace,
    modelsTypes,
    extraModelFields,
    extraModelQueries,
    extraModelTypes,
    debug,
    maxManyAssociations,
    extraModelMutations,
    nameFormatter: defaultNameFormatter,
    subscriptionsContextFilter
  } = Object.assign({}, {
    namespace: '',
    modelsTypes: {},
    extraModelTypes: () => ({}),
    extraModelFields: () => ({}),
    extraModelQueries: () => ({}),
    extraModelMutations: () => ({}),
    debug: false,
    maxManyAssociations: 3,
    nameFormatter: null,
    subscriptionsContextFilter: () => true
  }, options)

  // const modelsTypes = {}
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
      modelMetaType,
      modelIDType,
      modelInsertInputType,
      modelUpdateInputType,
      ghostTypes
    } = typesBuilder(model, modelsTypes, typesCache, extraModelFields, { nameFormatter, logger, maxManyAssociations })

    // Union type does not expose its sub types, thus it is not included in schema, we have to force it
    for (const ghostType of ghostTypes) {
      if (typesNameSet.has(ghostType.name)) {
        continue
      }
      modelsTypes[ghostType.name] = ghostType
      typesNameSet.add(ghostType.name)
    }

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
    const countResolver = countResolverFactory(model, { nameFormatter, logger, maxManyAssociations })

    queries = {
      ...queries,
      ...queriesBuilder(model, modelType, modelMetaType, manyResolver, countResolver, { nameFormatter }),
      ...extraModelQueries({ modelsTypes, nameFormatter, logger }, model, queries)
    }

    mutations = {
      ...mutations,
      ...mutationsBuilder(model, modelType, modelInsertInputType, modelUpdateInputType, ghostTypes, manyResolver, sequelize, { nameFormatter, logger }),
      ...extraModelMutations({ modelsTypes, nameFormatter, logger }, model, mutations)
    }

    subscriptions = {
      ...subscriptions,
      ...subscriptionsBuilder(model, modelType, modelIDType, manyResolver, { nameFormatter, contextFilter: subscriptionsContextFilter })
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

export {
  schemaBuilder,
  getRequestedAttributes,
  beforeResolverFactory,
  findOptionsMerger,
  includesMerger,
  nameFormatterFactory,
  loggerFactory,
  beforeModelResolverFactory,
  beforeAssociationResolverFactory,
  resolveFragments,
  cleanWhereQuery
}
