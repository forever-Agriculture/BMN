// Exact CLI copies for a synthetic native discriminator. No production caller.
export function instrumentCliConnection(source: string, helperUrl: string, listenersFirst: boolean): string {
  source = source.replaceAll('\r\n', '\n')
  const replace = (old: string, next: string): void => {
    if (source.split(old).length !== 2) throw new Error('CLI connection diagnostic source guard failed')
    source = source.replace(old, next)
  }
  replace("from './safe-config-write.mjs'", `from ${JSON.stringify(helperUrl)}`)
  replace("import { createConnection } from 'node:net'", "import { createConnection, Socket } from 'node:net'")
  replace('    const socket = createConnection(controlEndpoint(socketPath))', `    const diagnosticStart=Date.now();
    const diagnostic=stage=>writeSync(2, '[BMN_SYNTHETIC_CLIENT]'+JSON.stringify({stage,elapsedMs:Date.now()-diagnosticStart,node:process.versions.node,bun:process.versions.bun??null,platform:process.platform})+'\\n');
    diagnostic('constructor-entry');
    const endpoint=controlEndpoint(socketPath);
    const socket=${listenersFirst ? 'new Socket()' : 'createConnection(endpoint)'};
    diagnostic('constructor-return');`)
  replace('    const timer = setTimeout(() => {', "    diagnostic('timer-arm');\n    const timer = setTimeout(() => {\n      diagnostic('timer-fire');")
  replace('    function finish(error) {', "    function finish(error) {\n      diagnostic('finish-entry');")
  replace('      socket.destroy()', "      diagnostic('destroy-entry');socket.destroy();diagnostic('destroy-return');")
  replace("      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: requestMethod, params: requestParams })}\\n`)", "      diagnostic('write-entry');socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: requestMethod, params: requestParams })}\\n`,()=>diagnostic('write-callback'));diagnostic('write-return');")
  replace("    socket.on('connect', () => send(1, 'auth', { token }))", "    diagnostic('connect-listener-register');socket.on('connect', () => {diagnostic('connect-event');send(1, 'auth', { token })})")
  replace("    socket.on('data', (chunk) => {", "    socket.on('data', (chunk) => {\n      diagnostic('data-event');")
  replace("    socket.on('error', (error) => {", "    socket.on('error', (error) => {\n      diagnostic('error-event');")
  replace("    socket.on('close', () => {", "    socket.on('close', () => {\n      diagnostic('close-event');")
  replace("      finish(new CliError('IO_ERROR', 'control socket closed the connection before responding'))\n    })", "      finish(new CliError('IO_ERROR', 'control socket closed the connection before responding'))\n    });diagnostic('listeners-ready');" + (listenersFirst ? "diagnostic('connect-call-entry');socket.connect(endpoint);diagnostic('connect-call-return');" : ''))
  return source
}
