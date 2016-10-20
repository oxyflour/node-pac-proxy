#!/usr/bin/env node
'use strict'

const url = require('url'),
  net = require('net'),
  http = require('http'),
  fs = require('fs'),
  path = require('path'),
  socksv5 = require('socksv5'),
  program = require('commander')

const packageJson = require(__dirname, 'package.json')

program
  .version(packageJson.version)
  .usage('[options] <pac-file>')
  .option('-p, --port <n>', 'port number', parseInt, 3334)
  .parse(process.argv)

const pacFileName = program.args[0],
  loadPacFile = file => Function(fs.readFileSync(file, 'utf-8') + '; return FindProxyForURL')()
if (!pacFileName) {
  program.outputHelp()
  process.exit(-1)
}

let FindProxyForURL = loadPacFile(pacFileName)
console.log(`[pac] loaded ${pacFileName}`)
fs.watchFile(pacFileName, { interval: 2000 }, () => {
  console.log(`[pac] reloading ${pacFileName}`)
  FindProxyForURL = loadPacFile(pacFileName)
})

function getProxyOpts(reqUrl, reqHost) {
  let proxy = ''
  try {
    proxy = FindProxyForURL(reqUrl, reqHost)
    console.log(reqUrl, '->', proxy)
  }
  catch (err) {
    return { pacError: err }
  }

  const split = proxy.split(';').shift().split(' '),
    proxyMethod = split[0],
    addr = split.pop().split(':'),
    host = addr[0],
    port = parseInt(addr[1])
  if (proxyMethod === 'HTTP' || proxyMethod === 'PROXY') return {
    useProxy: true,
    host, port,
  }
  else if (proxyMethod === 'SOCKS5') return {
    useSocks: true,
    proxyHost: host,
    proxyPort: port,
    localDNS: false,
    auths: [ socksv5.auth.None() ]
  }
  else if (proxy === 'DIRECT') return {
    // nothing
  }
  else return {
    pacError: 'not implemented'
  }
}

// http://stackoverflow.com/questions/8165570/https-proxy-server-in-node-js
const server = http.createServer()

// http
server.addListener('request', (req, res) => {
  const parse = url.parse(req.url.match(/^\w+:\/\//) ? req.url : 'https://' + req.url)
  const opts = {
    host: parse.hostname,
    port: parse.port || 80,
    path: parse.path,
    method: req.method,
    headers: req.headers,
  }

  const proxy = getProxyOpts(req.url, parse.hostname)
  if (proxy.pacError) {
    res.write(`HTTP/${req.httpVersion} 500 OK\r\n\r\n${proxy.pacError || 'Boom!'}`)
    return res.end()
  }
  else {
    Object.assign(opts, proxy)
  }

  if (opts.useProxy) {
    // this fix squid invalid url issue
    if (opts.path.startsWith('/')) {
      opts.path = req.url
    }
  }

  if (opts.useSocks) {
    const addr = 'socks5:' + opts.proxyHost + ':' + opts.proxyPort
    opts.agent = server[addr] || (server[addr] = new socksv5.HttpAgent({
      proxyHost: opts.proxyHost,
      proxyPort: opts.proxyPort,
      auths: opts.auths,
    }))
  }

  const proxyReq = http.request(opts, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
  })
  req.pipe(proxyReq)
})

// https
server.addListener('connect', (req, res, headers) => {
  const parse = url.parse(req.url.match(/^\w+:\/\//) ? req.url : 'https://' + req.url)
  const opts = {
    host: parse.hostname,
    port: parse.port || 443,
  }

  const proxy = getProxyOpts(req.url, parse.hostname)
  if (proxy.pacError) {
    res.write(`HTTP/${req.httpVersion} 500 OK\r\n\r\n${proxy.pacError || 'Boom!'}`)
    return res.end()
  }
  else {
    Object.assign(opts, proxy)
  }

  if (opts.useSocks) {
    socksv5.createConnection(opts, proxySock => {
      res.write(`HTTP/${req.httpVersion} 200 Connection established\r\n\r\n`)
      proxySock.write(headers)
      proxySock.pipe(res)
      res.pipe(proxySock)
    })
    return
  }

  const proxySock = net.connect(opts, _ => {
    if (opts.useProxy) {
      proxySock.write(`CONNECT ${req.url} HTTP/${req.httpVersion}\r\n\r\n`)
    }
    else {
      res.write(`HTTP/${req.httpVersion} 200 Connection established\r\n\r\n`)
    }
    proxySock.write(headers)
    proxySock.pipe(res)
  })
  res.pipe(proxySock)
})

server.listen(program.port)