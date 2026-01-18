import pkg from '../package.json' with { type: 'json' }

const { name, version } = pkg
console.log(`${name.replaceAll('@', '').replaceAll('/', '-')}-v${version}.tgz`)