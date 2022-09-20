const deepmerge = require('deepmerge')
const { attributeFields } = require('graphql-sequelize')
const { GraphQLList, GraphQLNonNull } = require('graphql')
const { InputModelIDType } = require('./InputModelIDType')
const { getRequestedAttributes, parseGraphQLArgs, resolveFragments } = require('./graphql')
const { getFieldQuery } = require('./query')

const { GraphQLUnionInputType } = require('./GraphQLUnionInputType')
const { includesMerger } = require('./resolvers')

const getTargetKey = (association) => association.options.targetKey ?? association.target.primaryKeyAttribute

const inputResolver = async (input, model, inputType, { nameFormatter, logger, pubSub, transaction }) => {
  transaction = transaction ?? null
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
              { nameFormatter, logger, pubSub, transaction }
            )

            // Do we have to wait for parent creation ?
            if (model.associations[targetModelName].associationType === 'HasMany' &&
              !model.associations[targetModelName].target.rawAttributes[targetKey].allowNull) {
              resolvers.push(
                async (instance) => {
                  const createdModel = await targetModel.create(
                    {
                      ...foreignSequelizeInput,
                      [foreignKey]: instance[targetKey]
                    },
                    { transaction }
                  )
                  await Promise.all(foreignResolvers.map(resolver => resolver(createdModel)))
                  pubSub?.publish('modelsCreated', { model: targetModel, instances: [createdModel] })
                }
              )
            } else {
              const createdModel = await targetModel.create(
                foreignSequelizeInput,
                { transaction }
              )

              await Promise.all(foreignResolvers.map(resolver => resolver(createdModel)))

              // remember creations to set it all at once
              foreignCreations.push(createdModel)
            }
          }
        }

        resolvers.push(
          async (instance, method = 'set') => {
            // is there dereferenced or existing associations ?
            const dereferencedForeigns = []
            const existingForeigns = []
            if (pubSub && method === 'set') {
              const associatedModels = await instance[model.associations[targetModelName].accessors.get]({ transaction })
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

            if (foreignCreations.length) {
              pubSub?.publish('modelsCreated', { model: targetModel, instances: foreignCreations })
            }
            const result = await instance[model.associations[targetModelName].accessors[method]]([
              ...foreignIds,
              ...foreignCreations
            ], { transaction })

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
          if (model.associations[targetModelName].associationType === 'HasOne') {
            resolvers.push(
              async (instance) => {
                const target = await targetModel.findByPk(input[key][targetKey], { transaction })
                if (!target) {
                  throw Error(`${targetModelName} ${input[key][targetKey]} does not exists`)
                }
                const oldReferenced = await target[targetModel.associations[model.name].accessors.get]({ transaction })
                if (oldReferenced) {
                  pubSub?.publish('modelsUpdated', {
                    model,
                    instances: [oldReferenced]
                  })
                }

                const oldTarget = await instance[model.associations[targetModelName].accessors.get]({ transaction })
                if (oldTarget) {
                  await oldTarget.destroy({ transaction })
                  pubSub?.publish('modelsDeleted', {
                    model: targetModel,
                    ids: [target[targetModel.primaryKeyAttribute]]
                  })
                }
                target[targetKey] = instance[foreignKey]
                await target.save({ transaction })
                pubSub?.publish('modelsUpdated', {
                  model: targetModel,
                  instances: [target]
                })
              }
            )
          } else {
            sequelizeInput[foreignKey] = input[key][targetKey]
            // publish the fact that target is updated (its reverse many association changed)
            pubSub?.publish('modelsUpdated', {
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
            { nameFormatter, logger, pubSub, transaction }
          )
          if (model.associations[targetModelName].associationType === 'HasOne' &&
              !model.associations[targetModelName].target.rawAttributes[targetKey].allowNull) {
            resolvers.push(
              async (instance) => {
                const createdModel = await targetModel.create(
                  {
                    ...foreignSequelizeInput,
                    [foreignKey]: instance[targetKey]
                  },
                  { transaction }
                )
                await Promise.all(foreignResolvers.map((fr) => fr(createdModel)))
                pubSub?.publish('modelsCreated', { model: targetModel, instances: [createdModel] })
              }
            )
          } else {
            const createdModel = await targetModel.create(
              foreignSequelizeInput,
              { transaction }
            )

            await Promise.all(foreignResolvers.map((fr) => fr(createdModel)))
            pubSub?.publish('modelsCreated', {
              model: targetModel,
              instances: [createdModel]
            })
            sequelizeInput[foreignKey] = createdModel[targetKey]
          }
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

const getNestedElements = (model, infos, fieldNode, variables, nestedKeys, { nameFormatter, logger, maxManyAssociations }) => {
  logger.indent()
  const includes = []
  const attributes = []
  let countManyAssociation = 0
  const _maxManyAssociations = maxManyAssociations || 3 // Prevent multi left joins
  // logger.log('getNestedElements', { fieldNode })
  logger.log('getNestedElements', { start: model.name })
  if (fieldNode.selectionSet !== undefined && fieldNode.selectionSet.selections !== undefined) {
    // is there fragments in that selectionSet ?
    const resolvedSelections = resolveFragments(fieldNode.selectionSet.selections, infos)

    for (const field of resolvedSelections) {
      const { dissociate } = parseGraphQLArgs(field.arguments, variables)
      const fieldName = nameFormatter.fieldNameToModelName(field.name.value)

      if (dissociate) {
        // we have to query needed foreignKey
        if (['BelongsTo'].includes(model.associations[fieldName].associationType)) {
          const targetKey = getTargetKey(model.associations[fieldName])
          if (!attributes.includes(targetKey)) {
            attributes.push(targetKey)
          }
        }
        continue
      }

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
          attributes: getRequestedAttributes(model.associations[fieldName].target, field, infos, logger)
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
          [...nestedKeys, fieldName],
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

        const fieldQuery = getFieldQuery(model.associations[fieldName].target, field, variables, nameFormatter, [...nestedKeys, fieldName])

        // if (model.associations[fieldName].associationType !== 'HasMany' && fieldQuery?.separate) {
        //   console.log(fieldQuery)
        //   delete fieldQuery.separate
        //   console.log(fieldQuery)
        // }

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

  if (!attributes.length) {
    attributes.push(model.primaryKeyAttribute)
  }

  return { includes, attributes }
}

const findOptionsMerger = (fo1, fo2) => {
  const graphqlContext = fo1.graphqlContext || fo2.graphqlContext
  const include1 = fo1.include
  const include2 = fo2.include
  delete fo1.graphqlContext
  delete fo1.include
  delete fo2.graphqlContext
  delete fo2.include

  const findOptions = deepmerge(fo1, fo2)

  if (include1 && include2) {
    findOptions.include = includesMerger(include1, include2)
  } else if (include1) {
    findOptions.include = include1
  } else if (include2) {
    findOptions.include = include2
  }
  fo1.include = include1
  fo2.include = include2

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
  findOptionsMerger,
  getTargetKey
}
