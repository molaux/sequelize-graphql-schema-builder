const deepmerge = require('deepmerge')
const { attributeFields } = require('graphql-sequelize')
const { GraphQLList, GraphQLNonNull } = require('graphql')
const { InputModelIDType } = require('./InputModelIDType')
const { getRequestedAttributes, parseGraphQLArgs } = require('./graphql')
const { getFieldQuery } = require('./query')

const { GraphQLUnionInputType } = require('./GraphQLUnionInputType')

const getTargetKey = (association) => association.options.targetKey ?? association.target.primaryKeyAttribute

const inputResolver = async (input, model, inputType, { nameFormatter, logger, pubSub }) => {
  logger.indent()
  // const foreignHooks = []
  const resolvers = []
  const sequelizeInput = {}

  for (const key in input) {
    const targetModelName = nameFormatter.fieldNameToModelName(key)

    if (targetModelName in model.associations) {
      // Associations

      const targetKey = getTargetKey(model.associations[targetModelName])
      const foreignKey = model.associations[targetModelName].foreignKey.name ?? model.associations[targetModelName].foreignKey
      const targetModel = model.associations[targetModelName].target

      if (inputType.getFields()[key].type instanceof GraphQLList) {
        // [one|many] to many association

        if (!Array.isArray(input[key])) {
          throw Error(`${model.name} -> ${targetModelName} should be an array`)
        }

        const foreignIds = []
        const foreignCreations = []
        for (const inputItem of input[key]) {
          const ofType = inputType.getFields()[key].type.ofType instanceof GraphQLUnionInputType
            ? inputType.getFields()[key].type.ofType.getActualType({
              fields: Object.keys(inputItem).map((field) => ({ name: { value: field } }))
            })
            : inputType.getFields()[key].type.ofType

          // Check all inputs
          if (ofType instanceof InputModelIDType) {
            // associate with existing foreign
            logger.log('getNestedInputs oneToMany : Foreign simple', {
              key,
              'targetModel.name': targetModel.name,
              inputItem
            })
            foreignIds.push(inputItem[targetKey])
          } else {
            // associate with new one
            const {
              sequelizeInput: foreignSequelizeInput,
              resolvers: foreignResolvers
            } = await inputResolver(
              inputItem,
              targetModel,
              ofType,
              { nameFormatter, logger, pubSub }
            )

            // remember creations to set it all at once
            const createdModel = await targetModel.create(
              foreignSequelizeInput
            )

            await Promise.all(foreignResolvers.map(resolver => resolver(createdModel)))

            foreignCreations.push(createdModel)
          }
        }

        if (foreignIds.length || foreignCreations.length) {
          resolvers.push(
            async (instance, method = 'set') => {
              // is there dereferenced or existing associations ?
              const dereferencedForeigns = []
              const existingForeigns = []
              if (pubSub && method === 'set') {
                const associatedModels = await instance[model.associations[targetModelName].accessors.get]()
                for (const associatedModel of associatedModels) {
                  if (!foreignIds.find((id) => id === associatedModel[targetKey])) {
                    // foreigns does not include old associated model
                    dereferencedForeigns.push(associatedModel)
                  } else {
                    // foreign was already present
                    existingForeigns.push(associatedModel[targetKey])
                  }
                }
              }

              // TODO : if its a one to many, old referenced one has changed
              pubSub?.publish('modelsCreated', { model: targetModel, instances: foreignCreations })
              const result = await instance[model.associations[targetModelName].accessors[method]]([
                ...foreignIds,
                ...foreignCreations
              ])

              // publish foreign associations updates
              const newForeigns = foreignIds.filter((id) => !existingForeigns.find((existingForeignId) => existingForeignId === id))
              if (newForeigns.length || dereferencedForeigns.length) {
                pubSub?.publish(
                  'modelsUpdated',
                  {
                    model: targetModel,
                    instances: dereferencedForeigns,
                    ids: newForeigns
                  }
                )
              }

              return result
            }
          )
        }
      } else {
        // many to one association
        const finalType = inputType.getFields()[key].type instanceof GraphQLNonNull
          ? inputType.getFields()[key].type.ofType
          : inputType.getFields()[key].type
        const ofType = finalType instanceof GraphQLUnionInputType
          ? finalType.getActualType({
            fields: Object.keys(input[key]).map((field) => ({ name: { value: field } }))
          })
          : finalType

        // Creation or existing foreign ?
        if (ofType instanceof InputModelIDType) {
          logger.log('getNestedInputs manyToOne : Foreign simple', {
            key,
            'targetModel.name': targetModel.name,
            'input[key]': input[key]
          })
          sequelizeInput[foreignKey] = input[key][targetKey]
          // new foreign will be updated
          if (pubSub) {
            // publish the fact that target is updated (its reverse many association changed)
            pubSub.publish('modelsUpdated', {
              model: targetModel,
              ids: [input[key][targetKey]]
            })
          }
        } else {
          // Its a new associated model
          const {
            sequelizeInput: foreignSequelizeInput,
            resolvers: foreignResolvers
          } = await inputResolver(
            input[key],
            targetModel,
            ofType,
            { nameFormatter, logger, pubSub }
          )
          console.log('foreignSequelizeInput', foreignSequelizeInput)
          const createdModel = await targetModel.create(
            foreignSequelizeInput
          )

          await Promise.all(foreignResolvers.map((fr) => fr(createdModel)))
          pubSub?.publish('modelsCreated', {
            model: targetModel,
            instances: [createdModel]
          })

          sequelizeInput[foreignKey] = createdModel[targetKey]
        }
      }
    } else {
      // Scalar
      sequelizeInput[key] = input[key]
    }
  }
  // logger.log('findOptions getNestedInputs : end', { sequelizeInput, includes, foreignHooks })
  logger.outdent()
  return { sequelizeInput, resolvers }
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
      const { dissociate } = parseGraphQLArgs(field.arguments, variables)

      if (dissociate) {
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
  inputResolver,
  getNestedElements,
  findOptionsMerger
}
