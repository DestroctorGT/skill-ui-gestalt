---
name: ui-design-gestalt
description: "Trigger: crear o rediseñar secciones, páginas, cards, formularios, modales o layouts, mejorar jerarquía visual, o cualquier trabajo de UI/estilos. Detecta el sistema de diseño del proyecto y aplica las 9 leyes de Gestalt."
---

# UI con sistema de diseño + Gestalt

## Activation Contract

Cargar cuando el usuario pida crear, rediseñar o mejorar UI (sección, página, card, formulario, modal, layout, "que se vea mejor", jerarquía visual) en cualquier stack frontend, aunque no mencione Gestalt ni el sistema de diseño.

## Hard Rules

- Ejecutar el script de detección ANTES de diseñar. Nunca asumir rutas, tokens ni primitivos.
- El código del proyecto es la fuente de verdad; el JSON del script es solo un mapa.
- Usar solo tokens detectados. Sin hex ni valores mágicos si existe un token equivalente.
- Prioridad: primitivo existente > composición de primitivos > estilos sueltos.
- No agregar tokens a los archivos de tokens del proyecto sin avisar.
- No gastar colores de rol `reserved` como decoración.
- Un solo énfasis fuerte por vista.
- No apilar borde + sombra + fondo para separar: elegir uno.
- Tokens `inferred: true` NO son oficiales: declararlo explícitamente.

## Decision Gates

| Situación                            | Acción                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Varios `candidates`                  | Elegir el que contiene el archivo que se edita; si no hay archivo de referencia, hacer UNA pregunta al usuario y esperar |
| `designSystem: "formal"`             | Usar tokens y primitivos detectados                                                                                      |
| `designSystem: "partial"` o `"none"` | Diseñar dentro de la escala `inferred` y declarar que es inferida                                                        |
| Token en `unclassified`              | Leer su uso real, decidir su rol y declarar la decisión en el reporte                                                    |
| Falta token, primitivo o variante    | Avisar en una línea con alternativa y tradeoff; no resolver con un valor mágico                                          |
| `candidates: []`                     | Leer `warnings`, inspeccionar el proyecto a mano y avisar que no hay sistema detectado                                   |

## Execution Steps

1. **Detectar**: `node <skill-dir>/scripts/detect.mjs [--root <dir>]` (`<skill-dir>` = carpeta de este SKILL.md). Elegir perfil según el Decision Gate. Detalle del JSON: `references/detection.md`.
2. **Leer el código real** al que apunta el perfil: `tokenFiles`, cada primitivo que se vaya a usar (props y variantes), el componente a mejorar y su contexto (qué hay arriba y abajo).
3. **Tabla Gestalt breve** al usuario: solo leyes que deciden algo (4-6). Cada fila nombra una decisión verificable con el token o primitivo real. Detalle por ley: `references/gestalt.md`.

   | Ley        | Decisión concreta                           | Token / primitivo             |
   | ---------- | ------------------------------------------- | ----------------------------- |
   | Proximidad | label e input juntos; más aire entre campos | escala de espaciado detectada |

4. **Escribir el código**: usar el helper de merge de clases (`classMerge`) y el alias de importación (`importAlias`) detectados; imitar archivos vecinos (`conventions`); mobile first; estados completos (hover, focus-visible, disabled, error, loading, vacío) sin pisar los que traen los primitivos.
5. **Autochequeo**: un solo foco principal; cada valor justificado por un token o por el ritmo de la página; legible en 3 segundos; primitivos reutilizados; contraste legible (el rol más bajo de jerarquía de texto solo para metadata terciaria).

## Output Contract

1. Perfil elegido (`root`) y `designSystem`.
2. Tabla Gestalt breve.
3. El código.
4. Una línea por cada brecha del sistema (token, primitivo o variante faltante) con alternativa y tradeoff.
5. Lista de decisiones sobre `unclassified` y sobre valores `inferred` (marcadas como no oficiales).

## References

- `scripts/detect.mjs`: detección determinística (stdout JSON, `--help`).
- `references/detection.md`: contrato JSON, roles, heurísticas y límites.
- `references/gestalt.md`: las 9 leyes en términos de roles semánticos.
