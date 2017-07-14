#!/usr/bin/env node

const program = require('commander'),
  packageJson = require(__dirname, 'package.json'),
  startServer = require('./')

program
  .version(packageJson.version)
  .usage('[options] <pac-file>')
  .option('-p, --port <n>', 'port number', parseFloat, 3333)
  .parse(process.argv)

const pacFileName = program.args[0]
if (!pacFileName) {
  program.outputHelp()
  process.exit(-1)
}

startServer(pacFileName, program.port)