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

const nameFormatterBuilder = namespace => ({
    namespace,
    namespaceize:  function (name) { return namespace.length ? `${namespace}_${name}` : name },
    formatModelName: function (modelName) { return this.namespaceize(ucfirst(modelName)) },
    formatManyModelName: function (modelName) {
      const formattedModelName = this.formatModelName(modelName)
      const manyFormattedModelName = pluralize(formattedModelName)
      return manyFormattedModelName === formattedModelName ? `${formattedModelName}s` : manyFormattedModelName
    },
    formatTypeName: function (type) { return this.formatModelName(type) }
})


const sequelizeToGraphQLSchemaBuilder = (db, namespace, extraModelFields, extraModelQueries, extraModelTypes) => {
  let queries = {}
  let modelsTypes = {}
  const nameFormatter = nameFormatterBuilder(namespace)

  // Generate each model schema and resolver
  for (const modelName in db) {
    // const namespacedOriginalModelName = `${namespace}_${originalModelName}`
    if (modelName === 'Sequelize' || modelName === 'sequelize') {
      continue
    }

    const formattedModelName = nameFormatter.formatModelName(modelName)
    
    const model = db[modelName]

    // Manage association fileds resolvers
    let associationFields = {}
    for (const associationName in model.associations) {
      const association = model.associations[associationName]

      // Add assotiation fields to request and get it post computed to avoid circular dependance
      associationFields[association.as] = () => ({
        type: association.associationType === 'HasMany'
          ? new GraphQLList(modelsTypes[nameFormatter.formatTypeName(association.target.name)])
          : modelsTypes[nameFormatter.formatTypeName(association.target.name)],
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
    
    queries[nameFormatter.formatManyModelName(modelName)] = {
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
      ...extraModelQueries({ modelsTypes, nameFormatter }, formattedModelName, model, queries)
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
  sequelizeToGraphQLSchemaBuilder,
  getRequestedAttributes,
  beforeResolver,
  findOptionsMerger,
  nameFormatterBuilder
}
