# DECLARACIÓN DE TRANSPARENCIA DE IA

## para el Servicio LEX AI

*Última actualización: 14 de marzo de 2026*

---

Empresario individual Kyrychenko Igor Viktorovych
NIF (RNOKPP): 2967214056
Dirección: 04207, Ucrania, Kyiv, calle Levka Lukianenka 19, apt. 110
Correo electrónico: info@legal.org.ua

## 1. Finalidad de la Presente Declaración

La presente Declaración de Transparencia de IA describe los mecanismos de seguridad integrados en el servicio LEX AI para garantizar la calidad, exactitud y fiabilidad del análisis de documentos jurídicos basado en IA.

Creemos que el ámbito jurídico exige los más altos estándares de exactitud, razón por la cual implementamos un sistema multinivel de protección contra errores de IA.

## 2. HallucinationGuard — Protección contra Alucinaciones de IA

### 2.1. Qué Es HallucinationGuard

HallucinationGuard es un mecanismo de seguridad integrado que verifica automáticamente cada respuesta de IA antes de presentarla al Usuario. El sistema previene un problema común de los modelos de IA: la generación de información inexistente (las denominadas "alucinaciones").

### 2.2. Cómo Funciona HallucinationGuard

El proceso de verificación incluye varias etapas:

1. **Análisis del texto generado** — el sistema analiza cada respuesta de IA en busca de afirmaciones jurídicas específicas: referencias a artículos de legislación, números de resoluciones judiciales, fechas, nombres de jueces, etc.

2. **Cruce con fuentes** — cada afirmación jurídica se verifica contra bases de datos reales:
   - base de datos de legislación ucraniana (Verkhovna Rada, Zakon Online);
   - base de datos de resoluciones judiciales (EDRS);
   - registros estatales (EDR, EDRPOU).

3. **Evaluación de confianza** — el sistema asigna un nivel de confianza a cada afirmación:
   - **Alto** — la afirmación está confirmada por una fuente real;
   - **Medio** — la afirmación está parcialmente confirmada o la fuente requiere verificación adicional;
   - **Bajo** — la afirmación no está confirmada, marcada con un indicador especial.

4. **Filtrado y etiquetado** — las respuestas con afirmaciones no confirmadas se bloquean o se etiquetan con advertencias para el Usuario.

### 2.3. Qué Verifica HallucinationGuard

- La existencia de los artículos, apartados y cláusulas citados de la legislación;
- La correspondencia de los números de resoluciones judiciales con registros reales del EDRS;
- La corrección de las fechas de entrada en vigor de la legislación;
- La correspondencia de los nombres de los jueces con las composiciones judiciales reales;
- La consistencia lógica de las conclusiones jurídicas.

## 3. CitationValidator — Validación de Citas

### 3.1. Qué Es CitationValidator

CitationValidator es un mecanismo especializado que verifica cada cita en las respuestas de IA. Cuando la IA hace referencia a un artículo de ley o resolución judicial específicos, CitationValidator confirma que la cita coincide con el original.

### 3.2. Cómo Funciona CitationValidator

1. **Detección de citas** — el sistema identifica automáticamente todas las referencias en la respuesta de IA a:
   - artículos, apartados y cláusulas de leyes y códigos;
   - resoluciones judiciales específicas (por número de caso o número de registro);
   - legislación subordinada (resoluciones del Consejo de Ministros, órdenes ministeriales, etc.).

2. **Recuperación de la fuente original** — para cada cita, el sistema recupera el texto original de fuentes oficiales:
   - portal de la Verkhovna Rada de Ucrania;
   - Registro Estatal Único de Resoluciones Judiciales;
   - otras bases de datos oficiales.

3. **Comparación de textos** — el sistema compara el texto de la cita en la respuesta de IA con el original e identifica:
   - coincidencia total — la cita es exacta;
   - coincidencia parcial — existen diferencias menores (por ejemplo, abreviaturas);
   - discrepancia — el texto difiere significativamente del original.

4. **Notificación al Usuario** — el resultado de la verificación se muestra en la respuesta:
   - las citas confirmadas incluyen enlaces a la fuente original;
   - las discrepancias detectadas van acompañadas de advertencias.

### 3.3. Tipos de Verificación de CitationValidator

| Tipo de Verificación | Descripción |
|-------------------|-------------|
| Existencia de la norma | Si el artículo/apartado/cláusula citado existe en la legislación especificada |
| Vigencia de la norma | Si la norma está en vigor a la fecha actual |
| Exactitud del texto | Si el texto citado coincide con el original |
| Contexto de la decisión | Si el contenido de la referencia a la resolución judicial coincide con la decisión real |

## 4. Ranking Semántico

### 4.1. Qué Es el Ranking Semántico

El Ranking Semántico es un sistema inteligente de clasificación de resultados de búsqueda que garantiza que los documentos más relevantes aparezcan en las primeras posiciones.

### 4.2. Cómo Funciona el Ranking Semántico

1. **Representación vectorial** — la consulta del Usuario y los documentos de la base de datos se convierten en vectores numéricos (embeddings) utilizando el modelo text-embedding-3-small de OpenAI. El análisis de texto y la generación de respuestas se realizan principalmente con los modelos Anthropic Claude (Opus, Sonnet, Haiku) a través de AWS Bedrock, utilizando los modelos de OpenAI como ruta auxiliar.

2. **Comparación semántica** — el sistema compara el vector de la consulta con los vectores de los documentos por significado, no solo por palabras clave. Esto permite encontrar documentos que coinciden por contenido incluso cuando utilizan terminología diferente.

3. **Ranking multifactorial** — los resultados se clasifican por una combinación de factores:
   - similitud semántica con la consulta;
   - relevancia jurisprudencial (categoría del caso, instancia judicial);
   - actualidad (fecha de la decisión o últimas modificaciones de la legislación);
   - autoridad de la fuente (Tribunal Supremo, tribunales de apelación, etc.).

4. **Transparencia del ranking** — para cada resultado, el Usuario puede ver:
   - puntuación de relevancia;
   - fuente del documento;
   - herramientas de búsqueda utilizadas.

## 5. Sistema Integral de Seguridad

Los tres mecanismos descritos funcionan conjuntamente, creando un sistema de protección integral:

```
Consulta del Usuario
     |
Ranking Semántico -> encuentra las fuentes más relevantes
     |
Análisis de IA -> genera una respuesta basada en fuentes reales
     |
HallucinationGuard -> verifica los hechos de la respuesta
     |
CitationValidator -> valida cada cita
     |
Resultado -> respuesta verificada con referencias confirmadas
```

### 5.1. Beneficios del Enfoque Integral

- **Exactitud** — la verificación multinivel reduce significativamente la probabilidad de errores;
- **Transparencia** — los Usuarios ven las fuentes y los niveles de confianza de cada conclusión;
- **Trazabilidad** — cada paso del procesamiento se registra para fines de auditoría;
- **Retroalimentación** — los errores identificados por los Usuarios se utilizan para mejorar el sistema.

### 5.2. Limitaciones

A pesar del enfoque integral, ningún sistema de IA puede garantizar el 100% de exactitud. Casos posibles incluyen:
- la legislación nueva o recientemente modificada puede no estar aún actualizada en la base de datos;
- las situaciones jurídicas complejas pueden requerir una interpretación que excede las capacidades de la IA;
- la redacción ambigua de la legislación puede conducir a diferentes interpretaciones.

**Por lo tanto, los resultados del análisis de IA son una herramienta auxiliar y NO sustituyen el asesoramiento jurídico profesional.**

## 6. Nuestros Compromisos

La Empresa se compromete a:

1. **Mejorar continuamente** los mecanismos de seguridad de IA basándose en la retroalimentación de los Usuarios y las nuevas tecnologías;
2. **Garantizar la transparencia** — publicar información sobre cambios en el sistema de IA y actualizaciones de los mecanismos de seguridad;
3. **Responder con prontitud** a los informes de errores y tomar medidas para resolverlos;
4. **Mantener estándares** — cumplir con los requisitos de la Ley de IA de la UE, el RGPD y la legislación ucraniana;
5. **Informar a los Usuarios** — etiquetar claramente el contenido de IA y proporcionar enlaces a las fuentes originales.

## 7. Datos de Contacto

Para consultas sobre transparencia de IA y mecanismos de seguridad:

Empresario individual Kyrychenko Igor Viktorovych
NIF (RNOKPP): 2967214056
Dirección: 04207, Ucrania, Kyiv, calle Levka Lukianenka 19, apt. 110
Correo electrónico: info@legal.org.ua
Sitio web: https://legal.org.ua

---

*La presente Declaración entra en vigor desde su publicación en el sitio web del Servicio.*
