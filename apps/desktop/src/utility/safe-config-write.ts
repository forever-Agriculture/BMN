// MODULE: safe-config-write.ts - the utility process's view of the config writer bin/bmn also uses (one implementation, bundled here)
export {
  ConfigWriteError,
  currentText,
  jsonIndent,
  linkTarget,
  rewrittenNumbers,
  writeConfigSafely
} from '../../bin/safe-config-write.mjs'
