// MODULE: traced-control.mjs - does on purpose what a capture must never do, so that the reading of a trace is shown to see it: a write and a rename under a folder, another program, a connection
//
// node traced-control.mjs <folder>
import { execFileSync } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

const folder = process.argv[2]
writeFileSync(join(folder, 'written-by-the-control.txt'), 'x\n')
renameSync(join(folder, 'written-by-the-control.txt'), join(folder, 'renamed-by-the-control.txt'))
execFileSync('/usr/bin/true')
await new Promise((done) => {
  const socket = connect({ host: '127.0.0.1', port: 9 })
  socket.on('error', done)
  socket.on('connect', () => {
    socket.destroy()
    done()
  })
})
process.exit(0)
