# Contrato de detección (`scripts/detect.mjs`)

`node scripts/detect.mjs [--root <dir>] [--help]`. Solo lectura; imprime JSON en stdout; exit code 0 siempre. Determinístico: mismas entradas -> salida idéntica byte a byte (claves y listas ordenadas, sin timestamps).

## Forma del JSON

Nivel raíz: `tool`, `schemaVersion`, `scanRoot`, `candidates[]`, `warnings[]`, `limits`.

Cada candidato (un paquete frontend):

| Campo | Contenido |
| --- | --- |
| `root` | Ruta del paquete relativa a `scanRoot` (`.` si es la raíz) |
| `packageName` | `name` del package.json |
| `stack` | `styling[]`, `framework`, `frameworks[]`, `typescript`, `tailwindVersion` (3, 4 o null), `shadcn` (config o null), `libraries[]` |
| `designSystem` | `formal`, `partial` o `none` |
| `tokenFiles[]` | `{path, kind}`; `kind`: `tailwind-v4-theme`, `tailwind-config`, `css-variables`, `scss-variables`, `less-variables`, `design-tokens-json`, `theme-object` (+ `tokenFilesTruncated`) |
| `tokens[]` | `{name, value, source, kind, category, role, confidence, usage, inferred:false}` y opcionales `level`, `hint`, `resolvedValue` (+ `tokensTruncated`) |
| `roleCounts` | Cantidad de tokens por rol |
| `scales` | Nombres ordenados: `surfaceElevation`, `textHierarchy`, `action`, `border`, `emphasis`, `status{}`, `reserved`, `spacing`, `radius`, `fontSize` |
| `unclassified[]` | Tokens sin rol seguro: `{name, value, source, category, usage}` (+ `unclassifiedTruncated`) |
| `inferred` | `colors`, `radii`, `spacing`, `fontSizes`: `{items:[{value,count,inferred:true}], distinct, truncated}` |
| `primitives[]` | `{dir, components[], truncated}` |
| `classMerge` | `{helper:{name,file,importPath,implementation[]}|null, libraries[]}` o null |
| `importAlias` | `{configFile, baseUrl, paths:[{alias,targets[]}]}` o null |
| `conventions` | `fileNaming`, `componentStyle`, `exportStyle`, `quotes`, `semicolons`, `indent`, `dominantStyling`, `sampledFiles` |

## Estilos soportados

Tailwind v3 (`tailwind.config.*`), Tailwind v4 (`@theme`), CSS custom properties, CSS Modules, variables SCSS/Less, objetos de tema (styled-components, emotion, MUI, Chakra, `theme.ts`), tokens JSON (Style Dictionary, DTCG, `tokens.json`) y shadcn (`components.json`).

## Roles semánticos

`surface` (con `level`: 0 base, 10 superficie, 20 elevada, 30 overlay; +dígito del nombre), `text` (`level` 1 título, 2 cuerpo, 3 apoyo, 4 terciario), `border`, `action` (primaria/marca/CTA), `emphasis` (acento, secundario), `success`, `danger`, `warning`, `info`, `reserved` (color con significado propio: live, premium, promo...), `spacing`, `radius`, `font-size`, `font-family`, `shadow`, `z-index`, `other` (paletas crudas con `hint: palette`, pesos, breakpoints, transiciones).

## Heurísticas de clasificación

- Categoría: primero por valor (color hex/rgb/hsl/oklch/triplete HSL; unidades de dimensión), luego por palabras del nombre (`radius`, `shadow`, `font`, `space`, `z-index`...). Los alias `var(--x)` se resuelven (hasta 6 saltos) y quedan en `resolvedValue`.
- Rol de color por palabras del nombre, en este orden: reserved, estados (danger/success/warning/info), text, border, action, surface, emphasis, paleta cruda, nombres de color (red -> danger bajo confianza).
- Tailwind v4: el namespace (`--color-`, `--text-`, `--radius-`, `--spacing-`...) define la categoría.
- `usage`: ocurrencias del token (variable, utilidad o ruta de objeto) en el código, sin contar su definición.

## Interpretar campos

- `confidence` >= 0.8: confiar. 0.5-0.79: revisar el archivo antes de apoyarse en el rol. < 0.5 o sin rol: va a `unclassified`.
- `reserved` siempre tiene confianza baja (0.55): confirmar leyendo el uso real.
- `unclassified`: el modelo lee el uso (el `usage` indica relevancia), decide el rol y lo declara en el reporte.
- `inferred.*`: valores hardcodeados contados por frecuencia (orden: `count` desc, luego valor asc). NO son tokens oficiales; diseñar dentro de esa escala y decirlo.
- `designSystem`: `formal` = 8+ tokens clasificados en 3+ roles núcleo; `partial` = 1+ tokens; `none` = ninguno (usar `inferred`).
- `warnings`: archivos ilegibles o grandes omitidos, límites alcanzados, paquetes no frontend con estilos, ausencia de proyecto.

## Selección con varios candidatos

Monorepo: un perfil por cada `package.json` con dependencias frontend (ignora `node_modules`, `dist`, `build`, `out`, `coverage`, `public` y directorios ocultos). La raíz con `workspaces` se descarta si hay paquetes hijos. Elegir el perfil cuyo `root` contiene el archivo editado; sin archivo de referencia, preguntar al usuario. Para un paquete no frontend con tokens compartidos (ver `warnings`), ejecutar con `--root <ese paquete>`.

## Límites

- Heurísticas por nombre: nombres atípicos terminan en `unclassified`; el rol `reserved` no se puede inferir con certeza.
- Parser de objetos JS tolerante, no un evaluador: expresiones (`theme()`, spreads, imports) se omiten.
- Las variables CSS locales a un componente se listan igual que las globales; verificar el ámbito en el archivo.
- Alias de importación: solo `tsconfig*.json` / `jsconfig.json` del paquete; no lee aliases de bundlers ni `extends`.
- Variables en `<style>` de `.vue`/`.svelte`/`.astro` no se extraen como tokens.
- Topes: 12000 archivos, 512 KB por archivo, 400 tokens, 80 sin clasificar, 12 valores inferidos por tipo (los recortes se informan como `*Truncated`).
