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

const sequelizeToGraphQLSchemaBuilder = (sequelize, { namespace, extraModelFields, extraModelQueries, extraModelTypes, debug }) => {
  let queries = {}
  let modelsTypes = {}
  const nameFormatter = nameFormatterFactory(namespace)
  const logger = loggerFactory(debug)

  // Generate each model schema and resolver
  for (const modelName in sequelize.models) {

    const formattedModelName = nameFormatter.formatModelName(modelName)
    
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
          before: beforeResolver(association.target, { nameFormatter, logger })
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
        ...extraModelFields({ modelsTypes, nameFormatter }, model),
        ...Object.keys(associationFields).reduce((o, associationField) => {
          o[associationField] = associationFields[associationField]()
          return o
        }, {})
      })
    })

    // keep a trace of models to reuse in associations
    modelsTypes[nameFormatter.formatTypeName(modelName)] = modelType

    modelsTypes = {
      ...modelsTypes,
      ...extraModelTypes({ modelsTypes, nameFormatter }, formattedModelName, model)
    }

    // Root models query
    const manyModelName = nameFormatter.formatManyModelName(modelName)
    queries[nameFormatter.modelToFieldName(manyModelName)] = {
      // The resolver will use `findOne` or `findAll` depending on whether the field it's used in is a `GraphQLList` or not.
      type: new GraphQLList(modelType),
      args: {
        query: { type: GraphQLJSON },
        required: { type: GraphQLBoolean }
      },
      resolve: resolver(model, {
        before: async ({ attributes, ...otherFindOptions }, args, ctx, infos, ...rest) => {
          logger.log('root query resolver', {
            modelName: manyModelName,
            attributes
          })
          
          const findOptions = await beforeResolver(model, { nameFormatter, logger })({
            ...otherFindOptions,
            attributes: getRequestedAttributes(model, infos.fieldNodes[0], logger)
          }, args, ctx, infos, ...rest)
          
          logger.log('root query resolver', { 
            modelName: manyModelName,
            finalFindOptions: findOptions.attributes, 
            findOptions: findOptions.include
          })

          return findOptions
        }
      })
    }

    queries = {
      ...queries,
      ...extraModelQueries({ modelsTypes, nameFormatter }, formattedModelName, model, queries)
    }
  }

  return {
    modelsTypes,
    queries
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
