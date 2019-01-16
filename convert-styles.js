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

let isStylesReferenceAttribute = function(t) {
  return attr =>
    t.isJSXIdentifier(attr.name, { name: "style" }) &&
    t.isJSXExpressionContainer(attr.value) &&
    t.isMemberExpression(attr.value.expression) &&
    t.isIdentifier(attr.value.expression.object, {
      name: "styles"
    }) &&
    t.isIdentifier(attr.value.expression.property);
};

const astToJsonValue = (t, n) => {
  if (t.isNumericLiteral(n) || t.isStringLiteral(n)) return n.value;
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
  return ["${", generate(n).code, "}"].join("");
};

const checkForComplexStyles = (path, t, state) => {
  if (typeof state.keepRadium === "undefined") {
    state.keepRadium = false;
    state.keepStyles = false;
    path.parentPath.traverse({
      Identifier(path) {
        if (
          path.isReferencedIdentifier() &&
          path.isIdentifier({ name: "styles" })
        ) {
          state.keepStyles = true;
          console.log("keepStyles", generate(path.parent).code);
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
                const stylesObjects = astToJsonValue(t, objPath.node);
                const cssStrings = _.mapValues(stylesObjects, toCss);
                traverse(path.parent, {
                  JSXElement(path) {
                    const styleAttr = path.node.openingElement.attributes.find(
                      isStylesReferenceAttribute(t)
                    );
                    if (!styleAttr) return;
                    const eltName = path.node.openingElement.name;
                    const isBasicElement =
                      t.isJSXIdentifier(eltName) && /^[a-z]/.test(eltName.name);
                    const styleName = styleAttr.value.expression.property.name;
                    let css = cssStrings[styleName];
                    path.node.openingElement.attributes = path.node.openingElement.attributes.filter(
                      a => !isStylesReferenceAttribute(t)(a)
                    );
                    if (eltName.name === "ReactModal") {
                      state.keepStyles = true;
                      return;
                    }
                    if (!css) {
                      if (!stylesObjects[styleName])
                        console.warn(`Cannot resolve styles.${styleName}`);
                      else console.warn(`styles.${styleName} is empty?`);
                      return;
                    }
                    if (["button", "input"].includes(eltName.name)) {
                      css = `&&& {\n${css}\n}`;
                    }
                    let componentNamePrefix = eltName.name
                      .toLowerCase()
                      .includes(styleName.toLowerCase())
                      ? "Styled"
                      : _.upperFirst(styleName);
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
                    const componentName = componentNamePrefix.endsWith(
                      componentNameSuffix
                    )
                      ? componentNamePrefix
                      : [componentNamePrefix, componentNameSuffix].join("");
                    path.node.openingElement.name = t.jsxIdentifier(
                      componentName
                    );
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
                                  { cooked: css, raw: css },
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
                  path.insertAfter(Object.values(styledComponents));
                  if (!state.keepStyles) {
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
