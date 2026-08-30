import { main } from './main.js'

main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exitCode = 1
})
