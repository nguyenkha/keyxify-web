import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      // Context files intentionally export both context and hooks — this is idiomatic React
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        vars: 'all',
        args: 'all',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  // WalletConnect files use intentional `any` for complex SDK types — suppress noise
  {
    files: [
      'src/components/WCRequestApproval.tsx',
      'src/context/WalletConnectContext.tsx',
      'src/lib/walletconnect.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'no-unused-disable': 'off',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  // WebAuthn file uses intentional `any` for credential types
  {
    files: ['src/lib/passkey.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
])
