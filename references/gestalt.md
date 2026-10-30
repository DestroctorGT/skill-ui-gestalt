# Leyes de Gestalt por roles semánticos

Cada ley: **qué es -> cómo decidirla con roles -> anti-patrón**. Los roles (`surface`, `text`, `action`...) vienen de `detect.mjs`; ver `detection.md`. Los ejemplos de traducción son ilustrativos: usar siempre los nombres reales del proyecto.

Traducción de un mismo rol según el stack (ilustrativo):

| Concepto | Tailwind | CSS var | CSS Modules | Theme object |
| --- | --- | --- | --- | --- |
| Superficie elevada | `bg-<token-surface>` | `background: var(--<surface>)` | `.card { background: var(--<surface>) }` | `theme.colors.surface.raised` |
| Texto terciario | `text-<token-text-bajo>` | `color: var(--<text-low>)` | `.meta { color: var(--<text-low>) }` | `theme.colors.text.muted` |
| Separación interna | `gap-<paso-bajo>` | `gap: var(--<space-low>)` | `.group { gap: var(--<space-low>) }` | `theme.space[2]` |

## Contenido

1. Figura y fondo
2. Semejanza
3. Proximidad
4. Cierre
5. Pregnancia
6. Experiencia
7. Simplicidad
8. Simetría y orden
9. Continuidad
- Cómo combinan en un caso real

---

## 1. Figura y fondo

**Qué es:** el ojo separa el foco (figura) de lo que lo rodea (fondo). Sin contraste claro no hay foco.

**Decidir:** usar la escala de elevación de `surface` (de base a overlay). Sección en la superficie base, card una posición arriba, hover/inputs otra posición arriba; en modales el overlay oscurece el fondo y el panel es la figura. La acción `action` en relleno sólido es figura contra cualquier superficie.

**Anti-patrón:** card con la misma superficie que su fondo; apilar borde + sombra + fondo distinto cuando un salto de superficie ya separa.

## 2. Semejanza

**Qué es:** lo que se parece se percibe del mismo tipo o función.

**Decidir:** misma función -> mismo primitivo y misma variante. Todas las acciones primarias con la misma variante; todos los links de texto con el mismo componente; las cards de una grilla comparten radio, padding, superficie y hover. Lo que difiere en función debe diferir en forma (una acción secundaria no puede parecer primaria).

**Anti-patrón:** tres estilos de "ver más" en una página; cards de la misma lista con radios o paddings distintos.

## 3. Proximidad

**Qué es:** lo cercano se lee como grupo; la distancia comunica separación.

**Decidir:** escala creciente de la familia `spacing`: **dentro del grupo < entre grupos < entre secciones**. Elegir tres pasos distintos de la escala detectada (o de la `inferred`) y mantenerlos. Agrupar con espacio antes que con líneas.

**Anti-patrón:** mismo espacio en todo (nada se agrupa); un título más cerca del bloque anterior que del suyo.

## 4. Cierre

**Qué es:** completamos mentalmente formas incompletas; no hace falta cerrar todo con borde.

**Decidir:** si la superficie de la card ya contrasta con su fondo, omitir el `border`. En carruseles, dejar asomar el siguiente ítem. En listas, separadores sutiles (rol `border` más bajo) en vez de una caja por fila.

**Anti-patrón:** encerrar cada elemento en su propia caja; cortar contenido de modo que parezca un error y no una invitación a desplazarse.

## 5. Pregnancia (Prägnanz)

**Qué es:** interpretamos lo visual de la forma más simple, estable y ordenada posible; destaca lo que se resuelve fácil.

**Decidir:** jerarquía de pesos con la escala `text` (título -> cuerpo -> apoyo -> terciario) y la escala `font-size`. **Un solo foco de acción por sección**: la acción `action` en relleno; las alternativas en variante discreta. Los colores `reserved` y `emphasis` conservan fuerza porque no se usan de adorno.

**Anti-patrón:** dos botones sólidos compitiendo; título y cuerpo con casi el mismo peso; usar un color `reserved` en algo que no tiene ese significado.

## 6. Experiencia

**Qué es:** interpretamos según lo que ya conocemos; romper convenciones solo con motivo.

**Decidir:** reutilizar los patrones que el usuario ya aprendió en el producto y en la web: logo arriba a la izquierda, precio tachado = descuento, chevron = desplegable, subrayado/color de link = enlace, card completa clicable. Replicar ubicación y comportamiento de páginas hermanas y usar los primitivos que ya encarnan esos patrones (`primitives`).

**Anti-patrón:** un link sin apariencia de link; un ícono con otro significado que en el resto del producto; una acción destructiva con el estilo de la principal.

## 7. Simplicidad

**Qué es:** menos elementos, menos decisiones, más claridad; cada extra compite por atención.

**Decidir:** antes de agregar algo, preguntar qué decisión del usuario ayuda. Una variante por función, tres niveles de texto suelen alcanzar, un recurso de separación por vez. Más de un mensaje en una sección suele significar dos secciones.

**Anti-patrón:** íconos, badges y gradientes "para que se vea más rico" sin necesidad; campos de formulario que no se usan.

## 8. Simetría y orden

**Qué es:** lo simétrico y alineado se percibe estable; el desorden se lee como error.

**Decidir:** contenedor con el ancho máximo y padding lateral del resto de las páginas; grillas de columnas parejas; mismo padding en cards hermanas; un eje común de alineación por bloque; misma altura en elementos de una misma fila (alturas de control de la escala existente). La asimetría intencional vale si tiene un eje claro.

**Anti-patrón:** mezclar alineación izquierda y centrada en un bloque; cards de alturas dispares sin criterio; márgenes distintos en lados espejo.

## 9. Continuidad

**Qué es:** el ojo sigue líneas y curvas y prefiere trayectorias fluidas.

**Decidir:** alinear el borde izquierdo de título, texto y acción para formar una línea de lectura; mantener el mismo ritmo vertical entre secciones; carruseles y listas horizontales sobre un único eje; en formularios, un camino lineal con la acción final al final de esa línea.

**Anti-patrón:** saltos de ancho de contenedor entre secciones consecutivas; offsets distintos dentro de un mismo bloque; acción final fuera del camino de lectura.

---

## Cómo combinan en un caso real

Sección de planes (razonamiento, no código a copiar):

- **Figura y fondo + Pregnancia:** sección en la superficie base, cards una posición arriba; el plan recomendado se eleva con el rol `action` (borde o relleno) y es la única acción en relleno; los demás usan variante discreta.
- **Semejanza + Simetría:** todas las cards con mismo radio, padding y estructura (título, precio, lista, acción) y misma altura.
- **Proximidad + Continuidad:** precio pegado a su plan, lista de beneficios alineada a la izquierda, acción al final de esa misma línea.
- **Simplicidad + Cierre:** sin borde en las cards no destacadas; la superficie ya las delimita.
- **Experiencia:** precio anterior tachado con el patrón existente; la acción se parece al resto de acciones del producto.
