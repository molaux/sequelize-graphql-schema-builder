const {
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
  GraphQLID
} = require('graphql')

const { GraphQLJSON } = require('graphql-type-json')
const { attributeFields, resolver } = require('graphql-sequelize')
const pluralize = require('pluralize')

const {
  getInsertInputFields,
  getUpdateInputFields
} = require('./graphql.js')

const {
  InputModelAssociationType
} = require('./InputModelAssociationType')

const {
  InputModelIDTypeFactory
} = require('./InputModelIDType')

const {
  beforeResolverFactory
} = require('./resolvers.js')

module.exports = {
  builder: (model, modelsTypes, typesCache, extraModelFields, { nameFormatter, logger, maxManyAssociations }) => {
    const associationFields = {}

    for (const associationName in model.associations) {
      const association = model.associations[associationName]
      // Add assotiation fields to request and get it post computed to avoid circular dependance
      const isMany = ['HasMany', 'BelongsToMany'].includes(association.associationType)
      const fieldName = nameFormatter.modelNameToFieldName(isMany ? pluralize(association.as) : association.as, association.as)

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
      name: nameFormatter.formatTypeName(model.name),
      description: `${model.name} type`,
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
      name: `${nameFormatter.formatTypeName(model.name)}ID`,
      description: `${model.name} ID type`,
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
      name: nameFormatter.formatInsertInputTypeName(model.name),
      description: `${model.name} insert input type`,
      fields: () => ({
        ...getInsertInputFields(model, { cache: typesCache, nameFormatter }),
        // ...extraModelFields({ modelTypes, nameFormatter, logger }, model)
        ...Object.keys(associationInsertInputFields).reduce((o, associationField) => {
          o[associationField] = associationInsertInputFields[associationField]()
          return o
        }, {})
      })
    })

    const modelUpdateInputType = new GraphQLInputObjectType({
      name: nameFormatter.formatUpdateInputTypeName(model.name),
      description: `${model.name} update input type`,
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

    // keep a trace of models to reuse in associations
    return {
      modelTypes: {
        [nameFormatter.formatTypeName(model.name)]: modelType,
        [`${nameFormatter.formatTypeName(model.name)}ID`]: modelIDType,
        [nameFormatter.formatInsertInputTypeName(model.name)]: modelInsertInputType,
        [nameFormatter.formatUpdateInputTypeName(model.name)]: modelUpdateInputType
      },
      modelType,
      modelIDType,
      modelInsertInputType,
      modelUpdateInputType
    }
  }
}
