const util = require('util')

const loggerFactory = active => ({
  log: active
    ? (namespace, value) => (active === true || (typeof active === 'string' && namespace.startsWith(active)))
        ? console.log(namespace, util.inspect(value, false, null, true /* enable colors */))
        : null
    : () => null,
  indent: () => active
    ? console.group()
    : () => null,
  outdent: () => active
    ? console.groupEnd()
    : () => null
})

module.exports = {
  loggerFactory
}
