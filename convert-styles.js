import generate from "@babel/generator";
import postcss from "postcss";
import postcssJs from "postcss-js";
import _ from "lodash";

const toCss = style =>
  [
    "\n",
    postcss().process(
      _.mapKeys(style, (v, k) => (k[0] === ":" ? `&${k}` : k)),
      { parser: postcssJs }
    ).css,
    "\n"
  ].join("");

const isStylesMemberReference = (t, expression) =>
  t.isMemberExpression(expression) &&
  t.isIdentifier(expression.object, {
    name: "styles"
  }) &&
  t.isIdentifier(expression.property);

// If the given attribute matches one of:
//   style={styles.x}
//   style={{...styles.x, whatever}}
//   style={[styles.x, whatever]}
const getAttrReferencedStyles = function(t) {
  return styleAttr => {
    if (
      t.isJSXIdentifier(styleAttr.name, { name: "style" }) &&
      t.isJSXExpressionContainer(styleAttr.value)
    ) {
    }

    return null;
  };
};

const astToJsonValue = (t, n) => {
  if (t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isBooleanLiteral(n))
    return n.value;
  if (t.isNullLiteral(n)) return null;
  if (t.isObjectExpression(n)) {
    const obj = {};
    for (const prop of n.properties) {
      let k = t.isIdentifier(prop.key)
        ? prop.key.name
        : t.isStringLiteral(prop.key)
        ? prop.key.value
        : generate(prop.key).code;
      const v = astToJsonValue(t, prop.value);
      obj[k] = v;
    }
    return obj;
  }
  if (
    t.isUnaryExpression(n, { operator: "-", prefix: true }) &&
    t.isNumericLiteral(n.argument)
  ) {
    return -n.argument.value;
  }
  if (t.isTemplateLiteral(n)) {
    const parts = [];
    for (let i = 0; i < n.quasis.length; i++) {
      parts.push(n.quasis[i].value.raw);
      if (i < n.expressions.length) {
        parts.push("${");
        parts.push(generate(n.expressions[i]).code);
        parts.push("}");
      }
    }
    return parts.join("");
  }
  return ["${", generate(n).code, "}"].join("");
};

const isConstantLiteral = (t, n) => {
  if (
    t.isNumericLiteral(n) ||
    t.isStringLiteral(n) ||
    t.isBooleanLiteral(n) ||
    t.isNullLiteral(n)
  )
    return true;
  if (
    t.isUnaryExpression(n, { operator: "-", prefix: true }) &&
    t.isNumericLiteral(n.argument)
  ) {
    return true;
  }
  if (t.isArrayExpression(n)) {
    return n.elements.every(elt => isConstantLiteral(t, elt));
  }
  if (t.isObjectExpression(n)) {
    return n.properties.every(
      elt =>
        t.isObjectProperty(elt) &&
        (t.isIdentifier(elt.key) || t.isStringLiteral(elt.key)) &&
        isConstantLiteral(t, elt.value)
    );
  }
  if (t.isTemplateLiteral(n)) {
    return n.expressions.every(exp => isConstantLiteral(t, exp));
  }
  return false;
};
const checkForComplexStyles = (path, t, state) => {
  if (typeof state.keepRadium === "undefined") {
    state.keepRadium = false;
    state.keepAllStyles = false;
    state.stylesToKeep = new Set();
    path.traverse({
      Identifier(path) {
        if (
          path.isReferencedIdentifier() &&
          path.isIdentifier({ name: "styles" })
        ) {
          state.stylesToKeep.add(path.node.name);
        }
      },
      JSXAttribute(path) {
        const attr = path.node;
        if (t.isJSXIdentifier(attr.name, { name: "style" })) {
          if (
            t.isJSXExpressionContainer(attr.value) &&
            t.isMemberExpression(attr.value.expression) &&
            t.isIdentifier(attr.value.expression.object, {
              name: "styles"
            }) &&
            t.isIdentifier(attr.value.expression.property)
          ) {
            // Don't trigger this.Identifier on the child expression
            path.skip();
          } else {
            state.keepRadium = true;
          }
        }
      }
    });
  }
};
let removeStyleAttribute = function(t, openingElement) {
  openingElement.attributes = openingElement.attributes.filter(
    attr => !t.isJSXIdentifier(attr.name, { name: "style" })
  );
};

const addComponent = (
  t,
  styledComponents,
  componentName,
  isBasicElement,
  eltName,
  css
) => {
  if (["button", "input"].includes(eltName.name)) {
    css = `&&& {\n${css}\n}`;
  }
  styledComponents[componentName] = t.variableDeclaration("const", [
    t.variableDeclarator(
      t.identifier(componentName),
      t.taggedTemplateExpression(
        isBasicElement
          ? t.memberExpression(
              t.identifier("styled"),
              t.identifier(eltName.name)
            )
          : t.callExpression(t.identifier("styled"), [
              t.identifier(eltName.name)
            ]),
        t.templateLiteral(
          [t.templateElement({ cooked: css, raw: css }, true)],
          []
        )
      )
    )
  ]);
};
let addStyledImport = function(path, t) {
  path.unshiftContainer("body", [
    t.importDeclaration(
      [t.importDefaultSpecifier(t.identifier("styled"))],
      t.stringLiteral("styled-components")
    )
  ]);
};
let removeUnusedStyles = function(state, t) {
  state.stylesObjPath.node.properties = state.stylesObjPath.node.properties.filter(
    property =>
      !(
        t.isObjectProperty(property) &&
        t.isIdentifier(property.key) &&
        !state.stylesToKeep.has(property.key.name)
      )
  );
};
let addGeneratedStyledComponents = function(state, path, t) {
  if (state.stylesDeclPath) {
    state.stylesDeclPath.insertAfter(Object.values(state.styledComponents));
  } else {
    const index = path.node.body.findIndex(
      e => !t.isImportDeclaration(e) && !t.isExportDeclaration(e)
    );
    if (index === -1) {
      path.pushContainer("body", Object.values(state.styledComponents));
    } else {
      path.node.body.splice(index, 0, ...Object.values(state.styledComponents));
    }
  }
};
let removeStylesObjectIfEmpty = function(state) {
  if (state.stylesObjPath && state.stylesObjPath.node.properties.length === 0) {
    state.stylesDeclPath.remove();
  }
};
let generateComponentName = function(
  styleName,
  eltName,
  path,
  styledComponents
) {
  let componentNamePrefix =
    !styleName ||
    (
      eltName &&
      eltName.name &&
      eltName.name.toLowerCase().includes(styleName.toLowerCase())
    )
      ? "Styled"
      : styleName;
  let componentNameSuffix =
    {
      a: "Link",
      b: "Elt",
      em: "Elt",
      h1: "Heading",
      h2: "Heading",
      h3: "Heading",
      h4: "Heading",
      h5: "Heading",
      i: "Elt",
      li: "ListItem",
      ol: "List",
      p: "Paragraph",
      td: "Cell",
      th: "Heading",
      tr: "Row",
      ul: "List"
    }[eltName.name] ||
    _.upperFirst(generate(eltName).code.replace(/\/\/.*|[^A-Za-z0-9]+/g, ""));
  let componentName = componentNamePrefix.endsWith(componentNameSuffix)
    ? componentNamePrefix
    : [componentNamePrefix, componentNameSuffix].join("");
  const nameInUse = componentName =>
    styledComponents[componentName] || path.scope.hasBinding(componentName);
  if (nameInUse(componentName)) {
    let n = 2;
    while (nameInUse(`${componentName}${n}`)) {
      n++;
    }
    componentName = `${componentName}${n}`;
  }
  return componentName;
};
let getStyleJSXAttribute = function(openingElement, t) {
  const styleAttr = openingElement.attributes.find(
    attr =>
      t.isJSXIdentifier(attr.name, { name: "style" }) &&
      t.isJSXExpressionContainer(attr.value)
  );
  return styleAttr;
};
const plugin = ({ types: t }) => {
  return {
    visitor: {
      Program: {
        enter(path, state) {
          state.styledComponents = {};
          checkForComplexStyles(path, t, state);
        },
        exit(path, state) {
          if (!_.isEmpty(state.styledComponents)) {
            if (!path.scope.hasBinding("styled")) {
              addStyledImport(path, t);
            }
            if (!state.keepAllStyles && state.stylesDeclPath) {
              removeUnusedStyles(state, t);
            }
            addGeneratedStyledComponents(state, path, t);
            removeStylesObjectIfEmpty(state);
          }
        }
      },
      ImportDeclaration(path, state) {
        if (
          path.node.specifiers.length === 1 &&
          path.node.specifiers[0].local.name === "prefixStyles"
        ) {
          path.remove();
        } else if (path.node.source.value === "radium") {
          if (!state.keepRadium) {
            path.remove();
          }
        }
      },
      CallExpression(path, state) {
        if (path.get("callee").isIdentifier({ name: "prefixStyles" })) {
          path.replaceWith(path.node.arguments[0]);
        }
        if (
          path.get("callee").isIdentifier({ name: "Radium" }) &&
          !state.keepRadium
        ) {
          path.replaceWith(path.node.arguments[0]);
        }
      },
      JSXAttribute(path, state) {
        const attr = path.node;
        if (
          t.isJSXIdentifier(attr.name, { name: "style" }) &&
          t.isJSXExpressionContainer(attr.value) &&
          t.isObjectExpression(attr.value.expression) &&
          isConstantLiteral(t, attr.value.expression)
        ) {
          const styleObject = astToJsonValue(t, attr.value.expression);
          const css = toCss(styleObject);
          const openingElement = path.parentPath.node;
          const eltName = openingElement.name;
          const isBasicElement =
            t.isJSXIdentifier(eltName) && /^[a-z]/.test(eltName.name);
          const componentName = generateComponentName(
            "Styled",
            eltName,
            path,
            state.styledComponents
          );
          addComponent(
            t,
            state.styledComponents,
            componentName,
            isBasicElement,
            eltName,
            css
          );
          openingElement.name = t.jsxIdentifier(componentName);
          if (path.parentPath.parentPath.node.closingElement) {
            path.parentPath.parentPath.node.closingElement.name = t.jsxIdentifier(componentName);
          }
          path.remove();
        }
      },
      MemberExpression(membPath, state) {
        if (membPath.get("object").isIdentifier({ name: "styles" })) {
          if (membPath.get("property").isIdentifier()) {
            state.stylesToKeep.add(membPath.get("property").node.name);
          } else {
            state.keepAllStyles = true;
          }
        }
      },
      JSXElement(path, state) {
        const openingElement = path.node.openingElement;
        const styleAttr = getStyleJSXAttribute(openingElement, t);
        if (!styleAttr) return;
        const styleValue = styleAttr.value.expression;
        let styleNames = null;
        if (isStylesMemberReference(t, styleValue)) {
          styleNames = [styleValue.property.name];
          removeStyleAttribute(t, openingElement);
        } else if (t.isObjectExpression(styleValue)) {
          // If the style starts with styles references we can pull those out
          const idx = styleValue.properties.findIndex(
            p =>
              !(t.isSpreadElement(p) && isStylesMemberReference(t, p.argument))
          );
          if (idx < 0 || styleValue.properties.length === 0) {
            // In this case, the object is made entirely of spreads of styles elements
            styleNames = styleValue.properties.map(
              p => p.argument.property.name
            );
            removeStyleAttribute(t, openingElement);
          }
          if (idx > 0) {
            // Some properties are spreads of styles elements
            styleNames = styleValue.properties
              .slice(0, idx)
              .map(p => p.argument.property.name);
            styleValue.properties = styleValue.properties.slice(idx);
            if (
              styleValue.properties.length === 1 &&
              t.isSpreadElement(styleValue.properties[0])
            ) {
              styleAttr.value.expression = styleValue.properties[0].argument;
            }
          }
        } else if (t.isArrayExpression(styleValue)) {
          const idx = styleValue.elements.findIndex(
            elt => !isStylesMemberReference(t, elt)
          );
          if (idx < 0 || styleValue.elements.length === 0) {
            // Array made entirely of styles elements
            styleNames = styleValue.elements.map(elt => elt.property.name);
            removeStyleAttribute(t, openingElement);
          }
          // Cannot partially convert these arrays because styled-components
          // won't accept an array even if our component is wrapped using
          // Radium - Radium only affects simple elements returned from render
          // if (idx > 0) {
          //   styleNames = styleValue.elements
          //     .slice(0, idx)
          //     .map(elt => elt.property.name);
          //   styleValue.elements = styleValue.elements.slice(idx);
          //   if (
          //     styleValue.elements.length === 1 &&
          //     (t.isObjectExpression(styleValue.elements[0]) ||
          //       t.isMemberExpression(styleValue.elements[0]) ||
          //       t.isIdentifier(styleValue.elements[0]))
          //   ) {
          //     styleAttr.value.expression = styleValue.elements[0];
          //   }
          // }
        }
        if (!styleNames) return;
        const joinedStyleNames = styleNames.map(_.upperFirst).join("");
        const eltName = openingElement.name;
        const isBasicElement =
          t.isJSXIdentifier(eltName) && /^[a-z]/.test(eltName.name);
        let inlineStyle = styleNames
          .map(styleName => state.cssStrings[styleName])
          .join(";");
        if (eltName.name === "ReactModal") {
          for (const styleName of styleNames) {
            state.stylesToKeep.add(styleName);
          }
          return;
        }
        if (!inlineStyle) {
          if (!state.stylesObjects[styleNames[0]])
            console.warn(`Cannot resolve styles.${styleNames[0]}`);
          else console.warn(`styles.${styleNames[0]} is empty?`);
          return;
        }
        let componentName = generateComponentName(
          joinedStyleNames,
          eltName,
          path,
          state.styledComponents
        );
        openingElement.name = t.jsxIdentifier(componentName);
        if (path.node.closingElement) {
          path.node.closingElement.name = t.jsxIdentifier(componentName);
        }
        addComponent(
          t,
          state.styledComponents,
          componentName,
          isBasicElement,
          eltName,
          inlineStyle
        );
      },
      VariableDeclaration(path, state) {
        if (path.node.kind === "const") {
          path.traverse(
            {
              VariableDeclarator(varPath, state) {
                if (varPath.get("id").isIdentifier({ name: "styles" })) {
                  let objPath = varPath.get("init");
                  if (
                    objPath.isCallExpression() &&
                    objPath.get("callee").isIdentifier({ name: "prefixStyles" })
                  ) {
                    objPath.node = objPath.node.arguments[0];
                  }
                  if (
                    !t.isObjectExpression(objPath.node) ||
                    objPath.node.properties.some(p => !t.isObjectProperty(p))
                  ) {
                    path.stop();
                    return;
                  }
                  state.stylesObjects = astToJsonValue(t, objPath.node);
                  state.cssStrings = _.mapValues(state.stylesObjects, toCss);
                  state.stylesDeclPath = path;
                  state.stylesObjPath = objPath;
                }
              }
            },
            state
          );
        }
      }
    }
  };
};

export default plugin;
