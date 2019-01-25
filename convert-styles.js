import generate from "@babel/generator";
import traverse from "@babel/traverse";
import { parse } from "json5";
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

const checkForComplexStyles = (path, t, state) => {
  if (typeof state.keepRadium === "undefined") {
    state.keepRadium = false;
    state.keepAllStyles = false;
    state.stylesToKeep = new Set();
    path.parentPath.traverse({
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
const plugin = ({ types: t }) => {
  return {
    visitor: {
      ImportDeclaration(path, state) {
        if (
          path.node.specifiers.length === 1 &&
          path.node.specifiers[0].local.name === "prefixStyles"
        ) {
          path.remove();
        } else if (path.node.source.value === "radium") {
          checkForComplexStyles(path, t, state);
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
      VariableDeclaration(path, state) {
        if (path.node.kind === "const") {
          path.traverse({
            VariableDeclarator(varPath) {
              if (varPath.get("id").isIdentifier({ name: "styles" })) {
                const styledComponents = {};
                checkForComplexStyles(path, t, state);
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
                const stylesObjects = astToJsonValue(t, objPath.node);
                const cssStrings = _.mapValues(stylesObjects, toCss);
                traverse(path.parent, {
                  MemberExpression(membPath) {
                    if (
                      membPath.get("object").isIdentifier({ name: "styles" })
                    ) {
                      if (membPath.get("property").isIdentifier()) {
                        state.stylesToKeep.add(
                          membPath.get("property").node.name
                        );
                      } else {
                        state.keepAllStyles = true;
                      }
                    }
                  },
                  JSXElement(path) {
                    const openingElement = path.node.openingElement;
                    const styleAttr = openingElement.attributes.find(
                      attr =>
                        t.isJSXIdentifier(attr.name, { name: "style" }) &&
                        t.isJSXExpressionContainer(attr.value)
                    );
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
                          !(
                            t.isSpreadElement(p) &&
                            isStylesMemberReference(t, p.argument)
                          )
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
                        styleValue.properties = styleValue.properties.slice(
                          idx
                        );
                        if (
                          styleValue.properties.length === 1 &&
                          t.isSpreadElement(styleValue.properties[0])
                        ) {
                          styleAttr.value.expression =
                            styleValue.properties[0].argument;
                        }
                      }
                    } else if (t.isArrayExpression(styleValue)) {
                      const idx = styleValue.elements.findIndex(
                        elt => !isStylesMemberReference(t, elt)
                      );
                      if (idx < 0 || styleValue.elements.length === 0) {
                        // Array made entirely of styles elements
                        styleNames = styleValue.elements.map(
                          elt => elt.property.name
                        );
                        removeStyleAttribute(t, openingElement);
                      }
                      if (idx > 0) {
                        styleNames = styleValue.elements
                          .slice(0, idx)
                          .map(elt => elt.property.name);
                        styleValue.elements = styleValue.elements.slice(idx);
                        if (
                          styleValue.elements.length === 1 &&
                          (t.isObjectExpression(styleValue.elements[0]) ||
                            t.isMemberExpression(styleValue.elements[0]) ||
                            t.isIdentifier(styleValue.elements[0]))
                        ) {
                          styleAttr.value.expression = styleValue.elements[0];
                        }
                      }
                    }
                    if (!styleNames) return;
                    const joinedStyleNames = styleNames
                      .map(_.upperFirst)
                      .join("");
                    const eltName = openingElement.name;
                    const isBasicElement =
                      t.isJSXIdentifier(eltName) && /^[a-z]/.test(eltName.name);
                    let inlineStyle = styleNames
                      .map(styleName => cssStrings[styleName])
                      .join(";");
                    if (eltName.name === "ReactModal") {
                      for (const styleName of styleNames) {
                        state.stylesToKeep.add(styleName);
                      }
                      return;
                    }
                    if (!inlineStyle) {
                      if (!stylesObjects[styleNames[0]])
                        console.warn(`Cannot resolve styles.${styleNames[0]}`);
                      else console.warn(`styles.${styleNames[0]} is empty?`);
                      return;
                    }
                    if (["button", "input"].includes(eltName.name)) {
                      inlineStyle = `&&& {\n${inlineStyle}\n}`;
                    }
                    let componentNamePrefix = eltName.name
                      .toLowerCase()
                      .includes(joinedStyleNames.toLowerCase())
                      ? "Styled"
                      : joinedStyleNames;
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
                      _.upperFirst(
                        generate(eltName).code.replace(
                          /\/\/.*|[^A-Za-z0-9]+/g,
                          ""
                        )
                      );
                    let componentName = componentNamePrefix.endsWith(
                      componentNameSuffix
                    )
                      ? componentNamePrefix
                      : [componentNamePrefix, componentNameSuffix].join("");
                    if (path.scope.hasBinding(componentName)) {
                      let n = 2;
                      while (path.scope.hasBinding(`${componentName}${n}`)) {
                        n++;
                      }
                      componentName = `${componentName}${n}`;
                    }
                    openingElement.name = t.jsxIdentifier(componentName);
                    if (path.node.closingElement) {
                      path.node.closingElement.name = t.jsxIdentifier(
                        componentName
                      );
                    }
                    styledComponents[componentName] = t.variableDeclaration(
                      "const",
                      [
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
                              [
                                t.templateElement(
                                  { cooked: inlineStyle, raw: inlineStyle },
                                  true
                                )
                              ],
                              []
                            )
                          )
                        )
                      ]
                    );
                  }
                });

                if (!_.isEmpty(styledComponents)) {
                  if (!path.scope.hasBinding("styled")) {
                    path.parentPath.unshiftContainer("body", [
                      t.importDeclaration(
                        [t.importDefaultSpecifier(t.identifier("styled"))],
                        t.stringLiteral("styled-components")
                      )
                    ]);
                  }
                  if (!state.keepAllStyles) {
                    objPath.node.properties = objPath.node.properties.filter(
                      property =>
                        !(
                          t.isObjectProperty(property) &&
                          t.isIdentifier(property.key) &&
                          !state.stylesToKeep.has(property.key.name)
                        )
                    );
                  }
                  path.insertAfter(Object.values(styledComponents));
                  if (objPath.node.properties.length === 0) {
                    path.remove();
                  }
                }
              }
            }
          });
        }
      }
    }
  };
};

export default plugin;
