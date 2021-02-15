'use strict'
const {
  GraphQLObjectType,
  GraphQLString,
  GraphQLBoolean,
  GraphQLList
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
  findOptionsMerger
} = require('./lib/utils.js')

typeMapper.mapType((type) => {
  // map bools as strings
  if (type instanceof DataTypes.BLOB) {
    return GraphQLString
  }
  // use default for everything else
  return false
})

const sequelizeToGraphQLSchemaBuilder = (sequelize, { namespace, extraModelFields, extraModelQueries, extraModelTypes, debug, maxManyAssociations }) => {
  let queries = {}
  let modelsTypes = {}
  const nameFormatter = nameFormatterFactory(namespace)
  const logger = loggerFactory(debug)
  const typesNameSet = new Set()

  // Generate each model schema and resolver
  for (const modelName in sequelize.models) {

    const model = sequelize.models[modelName]
    
    // Manage association fileds resolvers
    let associationFields = {}
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

    let modelType = new GraphQLObjectType({
      name: nameFormatter.formatTypeName(modelName),
      description: `${modelName} type`,
      fields: () => ({
        ...attributeFields(model),
        ...extraModelFields({ modelsTypes, nameFormatter, logger }, model),
        ...Object.keys(associationFields).reduce((o, associationField) => {
          o[associationField] = associationFields[associationField]()
          return o
        }, {})
      })
    })

    if (typesNameSet.has(modelType.name)) {
      throw Error(`${model.name} -> modelsTypes already contains a type named ${type.name}`)
    }
    typesNameSet.add(modelType.name)
    
    // keep a trace of models to reuse in associations
    modelsTypes[nameFormatter.formatTypeName(modelName)] = modelType

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

    queries = {
      ...queries,
      ...extraModelQueries({ modelsTypes, nameFormatter, logger }, model, queries)
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

  return {
    modelsTypes,
    queries,
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
