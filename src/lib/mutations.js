const {
  GraphQLList,
  GraphQLBoolean
} = require('graphql')
const { GraphQLJSON } = require('graphql-type-json')

const { cleanWhereQuery } = require('./query.js')

const { AccumulatorPubSub } = require('./subscriptions')

const { inputResolver } = require('./sequelize')

module.exports = {
  builder: (model, modelType, modelInsertInputType, modelUpdateInputType, manyResolver, sequelize, { nameFormatter, logger }) => {
    const deleteMutationName = nameFormatter.formatDeleteMutationName(model.name)
    const insertMutationName = nameFormatter.formatInsertMutationName(model.name)
    const updateMutationName = nameFormatter.formatUpdateMutationName(model.name)

    return {
      [deleteMutationName]: {
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
            // TODO: consider foreigns oneToMany cascade set NULL or delete
            const models = await manyResolver(parent, { query, transaction }, { pubSub, ...ctx }, ...rest)

            await model.destroy({ where: cleanWhereQuery(model, query.where), transaction })

            if (transaction) {
              await transaction.commit()
            }

            pubSub?.publish('modelsDeleted', models)

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

            accumulatorPubSub?.flushTo(pubSub)

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

      [updateMutationName]: {
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
            for (const instance of await model.findAll({ where: cleanWhereQuery(model, query.where), transaction })) {
              for (const field in sequelizeSetInput) {
                instance[field] = sequelizeSetInput[field]
              }

              const removals = []
              for (const removeField in removeInput) {
                const foreignModelName = nameFormatter.fieldNameToModelName(removeField)
                const realFk = model.associations[foreignModelName].target.primaryKeyAttribute
                accumulatorPubSub?.publish('modelsRemoved', {
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

            accumulatorPubSub?.flushTo(pubSub)

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
}
