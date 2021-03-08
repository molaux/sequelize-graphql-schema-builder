const { GraphQLID, GraphQLInputObjectType } = require('graphql')

class InputModelIDType extends GraphQLInputObjectType {
}

class InputModelIDTypeFactory {
  constructor (association) {
    const realFk = Object.keys(association.target.primaryKeys)[0]
    if (!InputModelIDTypeFactory.register) {
      InputModelIDTypeFactory.register = {}
    }
    const name = `Input${association.target.name}By${realFk[0].toLocaleUpperCase() + realFk.slice(1)}`
    if (!InputModelIDTypeFactory.register[name]) {
      InputModelIDTypeFactory.register[name] = new InputModelIDType({
        name,
        fields: {
          [realFk]: {
            type: GraphQLID
          }
        }
      })
    }
    return InputModelIDTypeFactory.register[name]
  }
}

module.exports = {
  InputModelIDType,
  InputModelIDTypeFactory
}
