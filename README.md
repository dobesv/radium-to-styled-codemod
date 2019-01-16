# Radium & Inline Styles -> Styled Components Helper

This uses codemod to do a lot of the work of converting to styled components from Radium + inline styles.

It assumes a top-level component named `styles` that has the styles to be converted.  It finds references
to those styles in a `style` attribute of JSX elements, and emits a styled-component for it.

Usage:

    # Convert one file
    yarn codemod --printer prettier -p ./convert-styles.js '/full/path/to/src/file'
    # Convert many files
    yarn codemod --printer prettier -p ./convert-styles.js '/full/path/to/src/**/*.[jt]sx'

