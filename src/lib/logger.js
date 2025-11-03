import util from 'util'

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

const recDir = (o, indent) => {
  const prefix = new Array((indent ?? 0) + 1).join(' ')
  const indentWrite = (s) => process.stdout.write(`${prefix}${s}`)
  const write = (s) => process.stdout.write(`${s}`)
  const nextIndent = (indent ?? 0) + 2
  if (o?.prototype?.constructor !== undefined) {
    write(`Constructor [${o.prototype?.constructor.name}]`)
  } else if (Array.isArray(o)) {
    write('[\n')
    for (const e of o) {
      indentWrite('  ')
      recDir(e, nextIndent)
      write(',\n')
    }
    indentWrite(']')
  } else if (o instanceof Date) {
    write(o.toISOString())
  } else if (typeof o === 'string') {
    write(`"${o}"`)
  } else if (typeof o === 'function') {
    write('(?) => ?')
  } else if (typeof o === 'object' && o !== null) {
    write('{\n')
    for (const k of Object.keys(o)) {
      indentWrite(`  ${k}: `)
      recDir(o[k], nextIndent)
      write(',\n')
    }
    for (const k of Object.getOwnPropertySymbols(o)) {
      indentWrite(`  ${k.toString()}: `)
      recDir(o[k], nextIndent)
      write(',\n')
    }
    indentWrite('}')
  } else {
    write(o)
  }
}

const dir = (...args) => {
  for (const o of args) {
    recDir(o)
    process.stdout.write(' ')
  }
  console.log()
}

export {
  loggerFactory,
  dir
}
