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

const {
  getTargetKey
} = require('./sequelize')

module.exports = {
  builder: (model, modelsTypes, typesCache, extraModelFields, { nameFormatter, logger, maxManyAssociations }) => {
    const associationFields = {}
    const inputModelIDTypes = []
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

      inputModelIDTypes.push(new InputModelIDTypeFactory(association))
    }

    // Add to base model type : its own field and association fields as post computable fields
    // to avoid circular dependancies

    const rawFields = attributeFields(model, { cache: typesCache })
    const rawFieldsWithoutFks = { ...rawFields }
    const associationsFk = new Set(Object.values(model.associations)
      .filter(({ associationType }) => associationType === 'BelongsTo')
      .map(({ options: { foreignKey } }) => foreignKey.name ?? foreignKey))

    for (const field in rawFields) {
      if (model.rawAttributes[field].primaryKey || associationsFk.has(field)) {
        rawFields[field].type = rawFields[field].type instanceof GraphQLNonNull
          ? new GraphQLNonNull(GraphQLID)
          : GraphQLID
      }
      // remove association fields
      if (associationsFk.has(field) && !model.rawAttributes[field].primaryKey) {
        delete rawFieldsWithoutFks[field]
      }
    }

    const modelType = new GraphQLObjectType({
      name: nameFormatter.formatTypeName(model.name),
      description: `${model.name} type`,
      fields: () => ({
        ...rawFieldsWithoutFks,
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
    const associationsFieldsTypeMap = new Map()
    const associationInsertInputFields = {}
    const associationUpdateInputFields = {}
    const associationRemovableModelIDInputFields = {}
    for (const associationName in model.associations) {
      const association = model.associations[associationName]
      const isMany = ['HasMany', 'BelongsToMany'].includes(association.associationType)
      const fieldName = nameFormatter.modelNameToFieldName(isMany ? pluralize(association.as) : association.as, association.as)
      associationsFieldsTypeMap.set(fieldName, association.as)
      const foreignKey = association.options.foreignKey.name ?? association.options.foreignKey
      const isNonNull = association.associationType === 'BelongsTo' && rawFields[foreignKey] && (rawFields[foreignKey].type instanceof GraphQLNonNull)

      const type = () => isMany
        ? new GraphQLList(new InputModelAssociationType(
          association,
          modelsTypes[nameFormatter
            .formatInsertInputTypeName(
              association.target.name,
              Object.values(association.target.associations)
                .filter((targetAssociation) => {
                  if (['BelongsToMany', 'HasOne'].includes(association.associationType)) {
                    return targetAssociation.target === model
                  }
                  return model.name === targetAssociation.target.name && getTargetKey(targetAssociation) === getTargetKey(association)
                })[0].as
            )]))
        : new InputModelAssociationType(
          association,
          modelsTypes[nameFormatter
            .formatInsertInputTypeName(
              association.target.name,
              Object.values(association.target.associations)
                .filter((targetAssociation) => {
                  if (['BelongsToMany', 'HasOne'].includes(association.associationType)) {
                    return targetAssociation.target === model
                  }
                  return model.name === targetAssociation.target.name && getTargetKey(targetAssociation) === getTargetKey(association)
                })[0].as
            )])

      associationInsertInputFields[fieldName] = () => ({
        type: isNonNull ? new GraphQLNonNull(type()) : type()
      })

      associationUpdateInputFields[fieldName] = () => ({
        type: type()
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

    const modelInsertInputTypeThroughModels = []
    for (const associationName in model.associations) {
      const association = model.associations[associationName]
      const inputFields = getInsertInputFields(model, { cache: typesCache, nameFormatter })
      if (association.associationType === 'BelongsTo') {
        delete inputFields[association.options.foreignKey.name || association.options.foreignKey]
      }
      modelInsertInputTypeThroughModels.push(new GraphQLInputObjectType({
        name: nameFormatter.formatInsertInputTypeName(model.name, association.as),
        description: `${model.name} insert input type through ${association.as}`,
        fields: () => ({
          ...inputFields,
          ...Object
            .keys(associationInsertInputFields)
            .filter((associationField) => associationsFieldsTypeMap.get(associationField) !== association.as)
            .reduce((o, associationField) => {
              o[associationField] = associationInsertInputFields[associationField]()
              return o
            }, {})
        })
      }))
    }

    const modelUpdateInputType = new GraphQLInputObjectType({
      name: nameFormatter.formatUpdateInputTypeName(model.name),
      description: `${model.name} update input type`,
      fields: () => ({
        ...getUpdateInputFields(model, { cache: typesCache }),
        ...Object.keys(associationUpdateInputFields).reduce((o, associationField) => {
          o[associationField] = associationUpdateInputFields[associationField]()
          if (o[associationField].type instanceof GraphQLList) {
            o[`add${associationField}`] = associationUpdateInputFields[associationField]()
            if (associationRemovableModelIDInputFields[associationField] !== undefined) {
              o[`remove${associationField}`] = associationRemovableModelIDInputFields[associationField]()
            }
          }
          return o
        }, {})
      })
    })

    const modelValidatorType = new GraphQLObjectType({
      name: nameFormatter.formatValidatorTypeName(model.name),
      description: `Represents ${model.name} fields validators`,
      fields: () => Object.keys(model.rawAttributes).reduce((o, attribute) => ({
        ...o,
        [attribute]: { type: GraphQLJSON }
      }), {})
    })

    // keep a trace of models to reuse in associations
    return {
      modelTypes: {
        [nameFormatter.formatTypeName(model.name)]: modelType,
        [`${nameFormatter.formatTypeName(model.name)}ID`]: modelIDType,
        [nameFormatter.formatInsertInputTypeName(model.name)]: modelInsertInputType,
        [nameFormatter.formatUpdateInputTypeName(model.name)]: modelUpdateInputType,
        [nameFormatter.formatValidatorTypeName(model.name)]: modelValidatorType
      },
      modelType,
      modelValidatorType,
      modelIDType,
      modelInsertInputType,
      modelUpdateInputType,
      ghostTypes: inputModelIDTypes.concat(modelInsertInputTypeThroughModels)
    }
  }
}
