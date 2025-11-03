import { GraphQLUnionInputTypeBuilder } from './GraphQLUnionInputType.js'
import { InputModelIDTypeFactory } from './InputModelIDType.js'
const MODEL_ID = 'model_id'
const MODEL_TYPE = 'model_type'

const inputModelAssociationDiscriminator = (fields, fk) => {
  if (Object.keys(fields).length === 1 && Object.keys(fields)[0] === fk) {
    return MODEL_ID
  } else {
    return MODEL_TYPE
  }
}

class InputModelAssociationType {
  constructor (association, ModelInputType) {
    const realFk = Object.keys(association.target.primaryKeys)[0]
    if (!InputModelAssociationType.register) {
      InputModelAssociationType.register = {}
    }
    const name = `Input${association.target.name}By${realFk[0].toLocaleUpperCase() + realFk.slice(1)}Or${ModelInputType.name}`
    if (!InputModelAssociationType.register[name]) {
      InputModelAssociationType.register[name] = new GraphQLUnionInputTypeBuilder({
        name,
        resolveTypeFromAst: (ast) => {
          if (ModelInputType === undefined) {
            throw Error(`Model input type has not been defined (association name: ${association.target.name})`)
          }
          switch (inputModelAssociationDiscriminator(ast.fields.reduce((fields, { name: { value } }) => ({ ...fields, [value]: true }), {}), realFk)) {
            case MODEL_ID: return new InputModelIDTypeFactory(association)
            default: return ModelInputType
          }
        },
        resolveTypeFromValue: (value) => {
          if (ModelInputType === undefined) {
            throw Error(`Model input type has not been defined (association name: ${association.target.name})`)
          }
          switch (inputModelAssociationDiscriminator(value, realFk)) {
            case MODEL_ID: return new InputModelIDTypeFactory(association)
            default: return ModelInputType
          }
        }
      })
    }
    return InputModelAssociationType.register[name]
  }
}

export {
  InputModelAssociationType,
  inputModelAssociationDiscriminator,
  MODEL_ID,
  MODEL_TYPE
}
