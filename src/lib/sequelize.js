const deepmerge = require('deepmerge')
const { attributeFields } = require('graphql-sequelize')
const { GraphQLList, GraphQLNonNull } = require('graphql')
const { InputModelIDType } = require('./InputModelIDType')
const { getRequestedAttributes, parseGraphQLArgs } = require('./graphql')
const { getFieldQuery } = require('./query')

const { GraphQLUnionInputType } = require('./GraphQLUnionInputType')

const getTargetKey = (association) => association.options.targetKey ?? association.target.primaryKeyAttribute

const getNestedInputs = (input, model, inputType, { nameFormatter, logger }) => {
  logger.indent()
  const sequelizeInput = {}
  const includes = []
  const foreignHooks = []

  for (const key in input) {
    const modelName = nameFormatter.fieldNameToModelName(key)

    // Associations
    if (modelName in model.associations) {
      const targetKey = getTargetKey(model.associations[modelName])
      const foreignKey = model.associations[modelName].foreignKey.name ?? model.associations[modelName].foreignKey
      // many
      if (inputType.getFields()[key].type instanceof GraphQLList) {
        if (!Array.isArray(input[key])) {
          throw Error(`${model.name} -> ${modelName} should be an array`)
        }

        sequelizeInput[modelName] = []
        const mergedNestedIncludes = []
        const foreigns = []
        const foreignCreations = []
        for (const inputItem of input[key]) {
          const ofType = inputType.getFields()[key].type.ofType instanceof GraphQLUnionInputType
            ? inputType.getFields()[key].type.ofType.getActualType({
              fields: Object.keys(inputItem).map((field) => ({ name: { value: field } }))
            })
            : inputType.getFields()[key].type.ofType

          // Check all inputs
          const {
            sequelizeInput: nestedSequelizeInput,
            includes: nestedIncludes,
            foreignHooks: nestedForeignHooks
          } = getNestedInputs(
            inputItem,
            model.associations[modelName].target,
            ofType,
            { nameFormatter, logger }
          )

          if (ofType instanceof InputModelIDType) {
            logger.log('getNestedInputs oneToMany : Foreign simple', {
              key,
              'model.associations[modelName].target.name': model.associations[modelName].target.name,
              inputItem
            })
            // Should not be created, do not include inputs or includes
            foreigns.push(inputItem[targetKey])
            // Following does not work as for association setters
            // sequelizeInput[modelName].push(nestedSequelizeInput[targetKey])
          } else {
            // chain hooks
            if (nestedForeignHooks.length) {
              logger.log('getNestedInputs oneToMany : Foreign Need hooks', {
                key,
                'model.associations[modelName].target.name': model.associations[modelName].target.name,
                inputItem
              })
              // we cannot create through nested so manual create instead
              foreignCreations.push(async function () {
                if (!this.createdModel) {
                  this.createdModel = await model.associations[modelName].target.create(
                    nestedSequelizeInput,
                    { include: nestedIncludes }
                  )
                }
                await Promise.all(nestedForeignHooks.map(hook => hook(this.createdModel)))
                return this.createdModel
              })
            } else {
              logger.log('getNestedInputs oneToMany : Foreign Dont Need hooks', {
                key,
                'model.associations[modelName].target.name': model.associations[modelName].target.name,
                inputItem
              })
              // Its a new association with non model
              sequelizeInput[modelName].push(nestedSequelizeInput)

              // Don't merge twice the same model
              if (!nestedIncludes
                .filter(({ association: nestedAssociation }) => mergedNestedIncludes
                  .filter(({ association }) => association === nestedAssociation).length)
                .length) {
                mergedNestedIncludes.push(...nestedIncludes)
              }
            }
          }
        }

        if (foreigns.length || foreignCreations.length) {
          foreignHooks.push(
            async (instance, method = 'add') => {
              const foreignCreationsInstances = await Promise.all(foreignCreations.map(hook => hook()))
              return instance[model.associations[modelName].accessors[method]]([
                ...foreigns,
                ...foreignCreationsInstances
              ])
            }
          )
        }

        if (!mergedNestedIncludes
          .filter(({ association: nestedAssociation }) => includes
            .filter(({ association }) => association === nestedAssociation).length)
          .length) {
          includes.push(({
            association: model.associations[modelName],
            include: mergedNestedIncludes
          }))
        }
      } else {
        // one
        // Creation or foreign ?
        const finalType = inputType.getFields()[key].type instanceof GraphQLNonNull
          ? inputType.getFields()[key].type.ofType
          : inputType.getFields()[key].type
        const ofType = finalType instanceof GraphQLUnionInputType
          ? finalType.getActualType({
            fields: Object.keys(input[key]).map((field) => ({ name: { value: field } }))
          })
          : finalType

        const {
          sequelizeInput: nestedSequelizeInput,
          includes: nestedIncludes,
          foreignHooks: nestedForeignHooks
        } = getNestedInputs(
          input[key],
          model.associations[modelName].target,
          ofType,
          { nameFormatter, logger }
        )

        if (ofType instanceof InputModelIDType) {
          logger.log('getNestedInputs manyToOne : Foreign simple', {
            key,
            'model.associations[modelName].target.name': model.associations[modelName].target.name,
            'input[key]': input[key]
          })
          sequelizeInput[foreignKey] = input[key][targetKey]
        } else {
          // Its a new associated model
          if (nestedForeignHooks.length) {
            logger.log('getNestedInputs manyToOne : Foreign Need hooks', {
              key,
              'model.associations[modelName].target.name': model.associations[modelName].target.name,
              'input[key]': input[key]
            })
            // we cannot create through nested so manual create instead
            foreignHooks.push(
              async function (instance, method = 'set') {
                if (!this.createdModel) {
                  this.createdModel = await model.associations[modelName].target.create(
                    nestedSequelizeInput,
                    { include: nestedIncludes }
                  )
                }
                return instance[model.associations[modelName].accessors[method]](this.createdModel)
              }
            )
          } else {
            sequelizeInput[modelName] = nestedSequelizeInput
            includes.push({
              association: model.associations[modelName]
            })

            if (nestedIncludes.length && !nestedIncludes
              .filter(({ association: nestedAssociation }) => includes
                .filter(({ association }) => association === nestedAssociation).length)
              .length) {
              includes.push(nestedIncludes)
            }
          }
        }
      }
    } else {
      // Scalar
      sequelizeInput[key] = input[key]
    }
  }
  logger.log('findOptions getNestedInputs : end', { sequelizeInput, includes, foreignHooks })
  logger.outdent()
  return { sequelizeInput, includes, foreignHooks }
}

const getPrimaryKeyType = (model, cache) => {
  for (const attribute in model.rawAttributes) {
    if (model.rawAttributes[attribute].primaryKey === true) {
      return attributeFields(model, { cache, include: [attribute] })[attribute].type
    }
  }
  throw Error(`Primary key not found for ${model.name}`)
}

const getNestedElements = (model, infos, fieldNode, variables, { nameFormatter, logger, maxManyAssociations }) => {
  logger.indent()
  const includes = []
  const attributes = []
  let countManyAssociation = 0
  const _maxManyAssociations = maxManyAssociations || 3 // Prevent multi left joins
  // logger.log('getNestedElements', { fieldNode })
  logger.log('getNestedElements', { start: model.name })
  if (fieldNode.selectionSet !== undefined && fieldNode.selectionSet.selections !== undefined) {
    // is there fragments in that selectionSet ?
    const resolvedSelections = fieldNode.selectionSet.selections
    for (const field of fieldNode.selectionSet.selections) {
      // Resolve fragments selection
      if (field.kind === 'FragmentSpread') {
        const fragmentName = field.name.value
        const fragment = infos.fragments[fragmentName]

        logger.log('getNestedElements', {
          isFragment: true,
          fragmentName,
          fragment
        })

        if (fragment.selectionSet !== undefined && fragment.selectionSet.selections !== undefined) {
          resolvedSelections.push(...fragment.selectionSet.selections)
        }
      }
    }

    for (const field of resolvedSelections) {
      const { optimized } = parseGraphQLArgs(field.arguments, variables)

      if (((optimized !== undefined) && !optimized)) {
        continue
      }

      if (field.kind === 'FragmentSpread') {
        const fragmentName = field.name.value
        const fragment = infos.fragments[fragmentName]

        logger.log('getNestedElements', {
          isFragment: true,
          fragmentName,
          fragment
        })
      }

      const fieldName = nameFormatter.fieldNameToModelName(field.name.value)
      logger.log('getNestedElements', {
        fieldName,
        'field.name.value': field.name.value,
        'model.associations': model.associations,
        attributes
      })

      if (model.associations[fieldName] !== undefined) {
        let include = {
          model: model.associations[fieldName].target,
          as: model.associations[fieldName].as,
          attributes: getRequestedAttributes(model.associations[fieldName].target, field, logger)
        }
        logger.log('getNestedElements', {
          fieldName,
          'model.associations[fieldName] !== undefined': true,
          include,
          attributes,
          includes
        })

        if (model.associations[fieldName].associationType === 'BelongsTo') {
          const fkName = model.associations[fieldName].options.foreignKey.name
            ? model.associations[fieldName].options.foreignKey.name
            : model.associations[fieldName].options.foreignKey

          logger.log('getNestedElements', {
            fieldName,
            type: 'BelongsTo',
            'model.associations[fieldName].options.foreignKey': fkName
          })

          // Add the missing key
          if (!attributes.includes(fkName)) {
            attributes.push(fkName)
          }
        } else if (['HasMany'].includes(model.associations[fieldName].associationType)) {
          if (++countManyAssociation > _maxManyAssociations) {
            // TODO : avoid include associations with agreggation query
            continue
          }
          const targetKey = model.associations[fieldName].options.targetKey
          const tkName = targetKey ? targetKey.name ? targetKey.name : targetKey : undefined
          logger.log('getNestedElements', {
            fieldName,
            'model.associations[fieldName].options.targetKey': tkName,
            type: 'Many'
          })
          // Add the missing key
          if (targetKey !== undefined &&
            !attributes.includes(tkName)) {
            attributes.push(tkName)
          } else {
            for (const pk in model.primaryKeys) {
              if (!attributes.includes(pk)) {
                attributes.push(pk)
              }
            }
          }
        }

        const {
          includes: nestedIncludes,
          attributes: nestedAttributes
        } = getNestedElements(
          model.associations[fieldName].target,
          infos,
          field,
          variables,
          { nameFormatter, logger, maxManyAssociations }
        )

        for (const nestedAttribute of nestedAttributes) {
          if (!include.attributes.includes(nestedAttribute)) {
            include.attributes.push(nestedAttribute)
          }
        }

        logger.log('getNestedElements', {
          fieldName,
          include,
          attributes,
          nestedIncludes,
          nestedAttributes
        })

        if (nestedIncludes.length) {
          include.include = nestedIncludes
        }

        const fieldQuery = getFieldQuery(model.associations[fieldName].target, field, variables)

        if (fieldQuery !== null) {
          include = { ...include, ...fieldQuery }
        }
        includes.push(include)
      }
    }
  }
  logger.log('getNestedElements : end', {
    includes,
    attributes
  })
  logger.outdent()

  return { includes, attributes }
}

const findOptionsMerger = (fo1, fo2) => {
  const graphqlContext = fo1.graphqlContext || fo2.graphqlContext
  delete fo1.graphqlContext
  delete fo2.graphqlContext

  const findOptions = deepmerge(fo1, fo2)

  if ('include' in findOptions) {
    const reducedInclude = new Map()
    for (const include of findOptions.include) {
      if (!reducedInclude.has(include.model)) {
        reducedInclude.set(include.model, include)
      } else {
        reducedInclude.set(include.model, findOptionsMerger(reducedInclude.get(include.model), include))
      }
    }
    findOptions.include = Array.from(reducedInclude.values())
  }
  if (graphqlContext) {
    fo1.graphqlContext = graphqlContext
    fo2.graphqlContext = graphqlContext
    findOptions.graphqlContext = graphqlContext
  }
  return findOptions
}

module.exports = {
  getPrimaryKeyType,
  getNestedInputs,
  getNestedElements,
  findOptionsMerger
}
