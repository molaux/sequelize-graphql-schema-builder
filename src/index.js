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
const ucfirst = require('ucfirst')
const DataTypes = require('sequelize/lib/data-types')
const {
  beforeResolver,
  getRequestedAttributes,
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

const autoSequelize = (db, extraModelFields, extraModelQueries, extraModelTypes) => {
  let queries = {}

  let modelsTypes = {}

  // Generate each model schema and resolver
  for (let modelName in db) {
    const originalModelName = modelName

    const singularModelName = pluralize.singular(modelName)
    modelName = ucfirst(singularModelName in db ? modelName : pluralize.singular(modelName))
    if (modelName === 'Sequelize' || modelName === 'sequelize') {
      continue
    }
    const model = db[originalModelName]

    // Manage association fileds resolvers
    let associationFields = {}
    for (const associationName in model.associations) {
      const association = model.associations[associationName]

      // Add assotiation fields to request and get it post computed to avoid circular dependance
      associationFields[association.as] = () => ({
        type: association.associationType === 'HasMany'
          ? new GraphQLList(modelsTypes[association.target.name])
          : modelsTypes[association.target.name],
        args: {
          query: { type: GraphQLJSON },
          required: { type: GraphQLBoolean }
        },
        resolve: resolver(association, {
          before: beforeResolver(association.target)
        })
      })
    }

    // Add to base model type : its own field and association fields as post computable fields
    // to avoid circular dependances

    let modelType = new GraphQLObjectType({
      name: modelName,
      description: `${modelName} description...`,
      fields: () => ({
        ...attributeFields(model),
        ...extraModelFields({ modelsTypes }, model),
        ...Object.keys(associationFields).reduce((o, associationField) => {
          o[associationField] = associationFields[associationField]()
          return o
        }, {})
      })
    })

    // keep a trace of models to reuse in associations
    modelsTypes[originalModelName] = modelType

    modelsTypes = {
      ...modelsTypes,
      ...extraModelTypes({ modelsTypes }, modelName, model)
    }

    // Root models query
    let manyModelName = pluralize(modelName)
    queries[manyModelName === modelName ? `${modelName}s` : manyModelName] = {
      // The resolver will use `findOne` or `findAll` depending on whether the field it's used in is a `GraphQLList` or not.
      type: new GraphQLList(modelType),
      args: {
        query: { type: GraphQLJSON },
        required: { type: GraphQLBoolean }
      },
      resolve: resolver(model, {
        before: ({ attributes, ...otherFindOptions }, args, ctx, infos, ...rest) => beforeResolver(model)({
            ...otherFindOptions,
            attributes: getRequestedAttributes(model, infos.fieldNodes[0])
          }, args, ctx, infos, ...rest)
        
      })
    }

    queries = {
      ...queries,
      ...extraModelQueries({ modelsTypes }, modelName, model, queries)
    }
  }

  // modelsTypes = {
  //   ...modelsTypes,
  //   ...extraTypes({ modelsTypes })
  // }

  return {
    modelsTypes,
    queries
  }
}

module.exports = {
  autoSequelize,
  getRequestedAttributes,
  beforeResolver,
  findOptionsMerger
}
