import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'public/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['web/build.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
)
