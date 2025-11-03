import {
  GraphQLList,
  GraphQLBoolean
} from 'graphql'

import { GraphQLJSON } from 'graphql-type-json'

import { cleanWhereQuery } from './query.js'

import { AccumulatorPubSub } from './subscriptions.js'

import { inputResolver } from './sequelize.js'

export const builder = (model, modelType, modelInsertInputType, modelUpdateInputType, inputModelIDTypes, manyResolver, sequelize, { nameFormatter, logger }) => {
  const deleteMutationName = nameFormatter.formatDeleteMutationName(model.name)
  const insertMutationName = nameFormatter.formatInsertMutationName(model.name)
  const insertManyMutationName = nameFormatter.formatInsertManyMutationName(model.name)
  const updateMutationName = nameFormatter.formatUpdateMutationName(model.name)
  const mockMutationName = nameFormatter.formatMockMutationName(model.name)

  return {
    [mockMutationName]: {
      namespace: nameFormatter.formatModelName(model.name),
      type: modelType,
      args: inputModelIDTypes.reduce((args, type) => ({
        ...args,
        [type.name]: { type }
      }), {}),
      resolve: () => null
    },
    [deleteMutationName]: {
      namespace: nameFormatter.formatModelName(model.name),
      type: new GraphQLList(modelType),
      args: {
        query: { type: GraphQLJSON },
        atomic: { type: GraphQLBoolean }
      },
      resolve: async (parent, { query, atomic }, { pubSub, ...ctx }, ...rest) => {
        if (!query.where) {
          throw Error('You must define a where clause when deleting')
        }
        const transaction = atomic === undefined || atomic ? await sequelize.transaction() : null
        try {
          const accumulatorPubSub = pubSub
            ? new AccumulatorPubSub()
            : null
          // TODO: consider foreigns oneToMany cascade set NULL or delete
          const models = await manyResolver(parent, { query, transaction }, { pubSub, ...ctx }, ...rest)

          for (const targetModelName in model.associations) {
            const targetModel = model.associations[targetModelName].target
            const foreignInstances = await Promise.all(models.map((instance) => instance[model.associations[targetModelName].accessors.get]({ transaction })))
            const flattenForeigns = (['HasMany', 'BelongsToMany'].includes(model.associations[targetModelName].associationType)
              ? foreignInstances.flat()
              : foreignInstances).filter((instance) => instance)

            if (flattenForeigns.length) {
              accumulatorPubSub?.publish(
                'modelsUpdated',
                {
                  model: targetModel,
                  instances: flattenForeigns
                }
              )
            }
          }

          await model.destroy({ where: cleanWhereQuery(model, query.where, undefined, nameFormatter), transaction })

          accumulatorPubSub?.publish('modelsDeleted', { model, instances: models })

          if (transaction) {
            await transaction.commit()
          }
          accumulatorPubSub?.flushTo(pubSub, ctx)

          return models
        } catch (error) {
          if (transaction) {
            await transaction.rollback()
          }
          throw error
        }
      }
    },
    [insertMutationName]: {
      namespace: nameFormatter.formatModelName(model.name),
      type: modelType,
      args: {
        input: { type: modelInsertInputType },
        atomic: { type: GraphQLBoolean }
      },
      resolve: async (parent, { input, atomic }, { pubSub, ...ctx }, ...rest) => {
        const transaction = atomic === undefined || atomic ? await sequelize.transaction() : null

        try {
          const accumulatorPubSub = pubSub
            ? new AccumulatorPubSub()
            : null

          const { sequelizeInput, resolvers } = await inputResolver(
            input,
            model,
            modelInsertInputType,
            { nameFormatter, logger, pubSub: accumulatorPubSub, transaction }
          )
          const instance = await model.create(sequelizeInput, { transaction })

          await Promise.all(resolvers.map(r => r(instance, 'set')))
          accumulatorPubSub?.publish('modelsCreated', { model, instances: [instance] })

          if (transaction) {
            await transaction.commit()
          }

          accumulatorPubSub?.flushTo(pubSub, ctx)

          return manyResolver(parent, {
            query: {
              where: {
                [model.primaryKeyAttribute]: instance[model.primaryKeyAttribute]
              }
            }
          }, { pubSub, ...ctx }, ...rest)
        } catch (error) {
          if (transaction) {
            await transaction.rollback()
          }
          throw error
        }
      }
    },
    [insertManyMutationName]: {
      namespace: nameFormatter.formatModelName(model.name),
      type: new GraphQLList(modelType),
      args: {
        input: { type: new GraphQLList(modelInsertInputType) },
        atomic: { type: GraphQLBoolean }
      },
      resolve: async (parent, { input: inputList, atomic }, { pubSub, ...ctx }, ...rest) => {
        const transaction = atomic === undefined || atomic ? await sequelize.transaction() : null

        try {
          const accumulatorPubSub = pubSub
            ? new AccumulatorPubSub()
            : null
          const sequelizeInputList = []
          const resolvers = []

          for (const input of inputList) {
            const { sequelizeInput, resolvers: instanceResolvers } = await inputResolver(
              input,
              model,
              modelInsertInputType,
              { nameFormatter, logger, pubSub: accumulatorPubSub, transaction }
            )
            sequelizeInputList.push(sequelizeInput)
            resolvers.push(instanceResolvers)
          }
          const instances = await model.bulkCreate(sequelizeInputList, { transaction })

          await Promise.all(resolvers.map((instanceResolvers, i) => instanceResolvers.map(r => r(instances[i], 'set'))))
          accumulatorPubSub?.publish('modelsCreated', { model, instances })

          if (transaction) {
            await transaction.commit()
          }

          accumulatorPubSub?.flushTo(pubSub, ctx)
          return manyResolver(parent, {
            query: {
              where: {
                [model.primaryKeyAttribute]: {
                  _inOp: instances.map((i) => i[model.primaryKeyAttribute])
                }
              }
            }
          }, { pubSub, ...ctx }, ...rest)
        } catch (error) {
          if (transaction) {
            await transaction.rollback()
          }
          throw error
        }
      }
    },
    [updateMutationName]: {
      namespace: nameFormatter.formatModelName(model.name),
      type: new GraphQLList(modelType),
      args: {
        query: { type: GraphQLJSON },
        input: { type: modelUpdateInputType },
        atomic: { type: GraphQLBoolean }
      },
      resolve: async (parent, { query, input, atomic }, { pubSub, ...ctx }, ...rest) => {
        if (!query.where) {
          throw Error('You must define a where clause when updating')
        }

        const transaction = atomic === undefined || atomic ? await sequelize.transaction() : null

        try {
          const accumulatorPubSub = pubSub
            ? new AccumulatorPubSub()
            : null

          const setInput = {}
          const addInput = {}
          const removeInput = {}
          for (const rawField in input) {
            const matches = rawField.match(/^(?<action>add|remove)(?<field>.+)$/)
            const action = matches?.groups?.action ?? 'set'
            const field = matches?.groups?.field ?? rawField
            if (action === 'set') {
              setInput[field] = input[rawField]
            } else if (action === 'add') {
              addInput[field] = input[rawField]
            } else if (action === 'remove') {
              removeInput[field] = input[rawField]
            }
          }
          const {
            sequelizeInput: sequelizeSetInput,
            resolvers: setResolvers
          } = await inputResolver(
            setInput,
            model,
            modelInsertInputType,
            { nameFormatter, logger, pubSub: accumulatorPubSub, transaction }
          )

          const {
            sequelizeInput: sequelizeAddInput,
            resolvers: addResolvers
          } = await inputResolver(
            addInput,
            model,
            modelInsertInputType,
            { nameFormatter, logger, pubSub: accumulatorPubSub, transaction }
          )

          if (Object.keys(sequelizeAddInput).length) {
            throw Error('add association should not generate input')
          }

          const instances = []

          // retrieve instances targeted by query
          for (const instance of await model.findAll({ where: cleanWhereQuery(model, query.where, undefined, nameFormatter), transaction })) {
            for (const field in sequelizeSetInput) {
              instance[field] = sequelizeSetInput[field]
            }

            const removals = []
            for (const removeField in removeInput) {
              const foreignModelName = nameFormatter.fieldNameToModelName(removeField)
              const realFk = model.associations[foreignModelName].target.primaryKeyAttribute
              accumulatorPubSub?.publish('modelsUpdated', {
                model: model.associations[foreignModelName].target,
                ids: removeInput[removeField].map(oid => oid[realFk])
              })
              removals.push(instance[model.associations[foreignModelName].accessors.remove](
                removeInput[removeField].map(oid => oid[realFk]),
                { transaction }
              ))
            }
            await Promise.all([
              ...setResolvers.map((r) => r(instance, 'set')),
              ...addResolvers.map((r) => r(instance, 'add')),
              ...removals
            ])

            instances.push(instance)
          }

          await Promise.all(instances.map(instance => instance.save({ transaction })))

          accumulatorPubSub?.publish('modelsUpdated', { model, instances })

          if (transaction) {
            await transaction.commit()
          }

          accumulatorPubSub?.flushTo(pubSub, ctx)

          return manyResolver(parent, { query }, { pubSub, ...ctx }, ...rest)
        } catch (error) {
          if (transaction) {
            await transaction.rollback()
          }
          throw error
        }
      }
    }
  }
}
