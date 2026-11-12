# POLÍTICA DE USO DE INTELIGENCIA ARTIFICIAL

## para el Servicio LEX AI

*Última actualización: 14 de marzo de 2026*

---

Empresario individual Kyrychenko Igor Viktorovych
NIF (RNOKPP): 2967214056
Dirección: 47-Sadova, 1a, Kyiv 04132, Ucrania
Correo electrónico: info@legal.org.ua

## 1. Disposiciones Generales

La presente Política de Uso de Inteligencia Artificial (en adelante, la "Política de IA") describe los principios, limitaciones y garantías relacionados con el uso de tecnologías de inteligencia artificial (en adelante, "IA") dentro del servicio LEX AI (en adelante, el "Servicio").

La presente Política de IA es parte integrante de las Condiciones de Uso y se aplica conjuntamente con la Política de Privacidad, la Oferta Pública y el Acuerdo de Tratamiento de Datos (DPA).

## 2. Tecnologías de IA Utilizadas por el Servicio

El Servicio LEX AI utiliza modelos de inteligencia artificial para:

- **Análisis de documentos jurídicos** — identificación automática del tipo de documento, partes, fechas, términos clave y riesgos;
- **Búsqueda semántica** — búsqueda de resoluciones judiciales y legislación por significado, no solo por palabras clave;
- **Generación de respuestas** — elaboración de explicaciones jurídicas, resúmenes de documentos y conclusiones analíticas;
- **Clasificación y enrutamiento** — categorización automática de consultas para la selección óptima de la estrategia de búsqueda;
- **Embeddings vectoriales** — conversión de texto en vectores numéricos para la comparación semántica de documentos;
- **Verificación de citas** — validación de referencias a legislación y resoluciones judiciales.

### 2.1. Proveedores Externos de IA

El Servicio utiliza APIs de proveedores externos para procesar las consultas:

| Proveedor | Finalidad | Ubicación del Servidor |
|----------|---------|----------------|
| Anthropic (Claude Opus, Sonnet, Haiku) vía AWS Bedrock | Análisis principal de texto, generación de respuestas | UE (Fráncfort) |
| OpenAI (GPT-4o, GPT-4o-mini) | Análisis auxiliar de texto, generación de respuestas | EE.UU., UE |
| OpenAI (text-embedding-3-small) | Embeddings vectoriales | EE.UU., UE |

La Empresa puede cambiar la lista de proveedores de IA notificando a los Usuarios a través de la interfaz del Servicio o por correo electrónico.

### 2.2. Infraestructura Interna

- **Qdrant** — base de datos vectorial para almacenar y buscar embeddings (desplegada en servidores de la Empresa en la UE);
- **PostgreSQL** — almacenamiento de resultados de análisis, caché (servidores de la Empresa en la UE);
- **Redis** — caché de resultados intermedios del procesamiento de IA (servidores de la Empresa en la UE).

## 3. Cómo se Procesan los Datos del Usuario

### 3.1. Datos de Entrada

Al utilizar las funciones de IA del Servicio, se procesan los siguientes datos:
- consultas de texto del Usuario;
- documentos cargados (PDF, DOCX, HTML, TXT, RTF);
- contexto de la conversación (mensajes anteriores en la sesión de chat).

### 3.2. Principio de Minimización de Datos

El Servicio transmite únicamente los datos mínimos necesarios a los proveedores de IA:
- la consulta del Usuario y el contexto relevante;
- fragmentos de documentos (no el texto completo, sino solo las secciones relevantes);
- instrucciones del sistema para el modelo (que no contienen datos personales).

### 3.3. Prohibición de Entrenamiento con Datos de Usuarios

Los datos del Usuario **NO** se utilizan para:
- entrenar o ajustar modelos de IA;
- mejorar los modelos base de los proveedores (la API de OpenAI se utiliza con la opción de entrenamiento con datos desactivada; Anthropic no utiliza los datos transmitidos a través de AWS Bedrock para el entrenamiento de modelos);
- crear conjuntos de datos disponibles públicamente;
- transferir a terceros para cualquier fin distinto del procesamiento directo de consultas.

### 3.4. Almacenamiento y Eliminación

- Las consultas y respuestas de IA se almacenan en el historial de chat del Usuario;
- Los Usuarios pueden eliminar cualquier conversación de IA a través de la interfaz del Servicio;
- Tras la eliminación, los datos se eliminan de la base de datos en un plazo de 30 días;
- Las respuestas de IA en caché se eliminan automáticamente tras la expiración del período de caché (de 1 a 30 días según el tipo de datos);
- La eliminación de datos está sujeta a las restricciones impuestas por la Retención Legal (Legal Hold) (si procede).

## 4. Limitaciones y Exención de Responsabilidad

### 4.1. El Análisis de IA No Es Asesoramiento Jurídico

**IMPORTANTE:** Los resultados del análisis de IA tienen carácter exclusivamente informativo y de referencia.

La Empresa **NO** garantiza:
- la exactitud total, la actualidad o la integridad de los resultados;
- la correcta citación de legislación o resoluciones judiciales;
- la aplicabilidad de los resultados a una situación jurídica específica;
- la ausencia de las denominadas "alucinaciones" — casos en los que la IA genera normas o decisiones inexistentes.

### 4.2. Protección contra Alucinaciones

El Servicio emplea un sistema multinivel de protección contra errores de IA:
- **HallucinationGuard** — verificación automática de las referencias generadas contra fuentes reales;
- **CitationValidator** — validación de citas de legislación y resoluciones judiciales;
- **Fuentes** — cada respuesta de IA incluye referencias a las fuentes utilizadas para la verificación independiente.

A pesar de estas medidas, la Empresa no puede garantizar la ausencia total de errores. Los Usuarios están obligados a verificar de forma independiente la información de importancia crítica.

### 4.3. Restricciones de Uso

Los Usuarios se comprometen a **NO** utilizar las funciones de IA del Servicio para:
- generar información jurídica deliberadamente falsa;
- crear resoluciones judiciales o legislación falsas;
- la generación masiva automatizada de documentos jurídicos sin verificación;
- eludir los sistemas de seguridad o filtrado de IA;
- cualquier fin que infrinja la legislación de Ucrania o la legislación aplicable.

## 5. Transparencia y Responsabilidad

### 5.1. Etiquetado de Contenido de IA

Todas las respuestas generadas por IA están claramente etiquetadas en la interfaz del Servicio. Los Usuarios siempre ven:
- que la respuesta fue generada por IA;
- qué herramientas y fuentes se utilizaron;
- el coste del procesamiento de la consulta (para transparencia en la facturación).

### 5.2. Seguimiento de Costes

El Servicio mantiene registros detallados del uso de recursos de IA:
- número de tokens (entrada y salida) para cada consulta;
- modelo y tipo de procesamiento (rápido/estándar/profundo);
- coste de cada consulta.

Esta información está disponible para los Usuarios en la sección de su perfil.

### 5.3. Registro

Todas las operaciones de IA se registran con fines de:
- diagnóstico y mejora de la calidad del Servicio;
- investigación de incidentes de seguridad;
- cumplimiento de requisitos legales.

Los registros no contienen el texto completo de los documentos del Usuario — solo metadatos de las operaciones.

## 6. Derechos del Usuario Respecto al Procesamiento de IA

Los Usuarios tienen derecho a:
- **obtener una explicación** — solicitar cómo la IA llegó a una conclusión específica (a través de las fuentes y herramientas indicadas en la respuesta);
- **rechazar el procesamiento de IA** — utilizar únicamente herramientas de búsqueda manual sin análisis de IA;
- **eliminar datos** — eliminar todas las conversaciones de IA y los documentos cargados;
- **exportar datos** — recibir una copia de sus datos, incluido el historial de consultas de IA;
- **impugnar resultados** — informar sobre resultados erróneos o incorrectos del análisis de IA a info@legal.org.ua.

## 7. Seguridad del Procesamiento de IA

### 7.1. Medidas Técnicas

- cifrado de datos durante la transmisión a proveedores de IA (TLS 1.3);
- aislamiento de datos de diferentes Usuarios (segregación por asuntos);
- acceso restringido a funciones de IA mediante autenticación (JWT + OAuth);
- limitación de velocidad para prevenir abusos;
- monitorización de actividad anómala.

### 7.2. Medidas Organizativas

- solo el personal autorizado tiene acceso a los datos de procesamiento de IA;
- revisión y actualización periódicas de los modelos y prompts de IA;
- Evaluación de Impacto en la Protección de Datos (EIPD) antes de implementar nuevas funciones de IA.

## 8. Cumplimiento Normativo

La Empresa se esfuerza por cumplir con:
- **Ley de Ucrania "Sobre la Inteligencia Artificial"** (tras su adopción);
- **Ley de IA de la UE** (Reglamento UE 2024/1689) — en la medida aplicable a sistemas de IA de bajo riesgo;
- **RGPD** — en relación con la toma de decisiones automatizada (Art. 22);
- **Ley de Ucrania "Sobre la Protección de Datos Personales"**.

El Servicio se clasifica como un sistema de IA de **bajo riesgo** en virtud de la Ley de IA de la UE porque:
- no realiza toma de decisiones automatizada jurídicamente vinculante;
- proporciona únicamente apoyo informativo, siendo la decisión final tomada por el Usuario;
- no utiliza datos biométricos ni datos de categoría especial para el procesamiento de IA.

## 9. Cambios en la Presente Política

La Empresa puede actualizar la presente Política en relación con:
- cambios en los proveedores o modelos de IA;
- cambios en la legislación;
- ampliación de la funcionalidad de IA del Servicio.

Los Usuarios serán notificados de los cambios sustanciales con al menos 14 días de antelación a través de la interfaz del Servicio o por correo electrónico.

## 10. Nuestra Garantía de Calidad

La Empresa garantiza que cada resultado del análisis de IA se somete a verificación automática mediante mecanismos de seguridad integrados:

### 10.1. HallucinationGuard — Estándar para Todos los Resultados

HallucinationGuard es un componente obligatorio en el procesamiento de cada consulta de IA. Este mecanismo:
- analiza cada respuesta de IA en busca de normas, artículos o resoluciones judiciales potencialmente inexistentes;
- cruza las citas generadas con bases de datos reales de legislación y jurisprudencia;
- bloquea o marca las respuestas que contienen información no verificada;
- garantiza la transparencia — los Usuarios ven el nivel de confianza del sistema para cada conclusión.

### 10.2. CitationValidator — Estándar para Todos los Resultados

CitationValidator verifica automáticamente cada cita en las respuestas de IA:
- valida los números de artículo, apartado y cláusula de la legislación;
- verifica la existencia de las resoluciones judiciales citadas;
- compara el texto de la cita con la fuente original;
- notifica a los Usuarios de cualquier discrepancia detectada.

### 10.3. Notificación de Errores

Si un Usuario descubre un error en los resultados del análisis de IA:
1. Informe del error a través de la interfaz del Servicio o a info@legal.org.ua;
2. Indique la consulta exacta, la respuesta y la naturaleza del error;
3. Analizaremos el informe y tomaremos medidas para prevenir errores similares;
4. Previa solicitud, notificaremos al Usuario de los resultados de la revisión.

La Empresa se esfuerza por mejorar continuamente los mecanismos de protección y reducir los errores de IA.

## 11. Datos de Contacto

Para consultas sobre el uso de IA en el Servicio:
- Correo electrónico: info@legal.org.ua
- Sitio web: https://legal.org.ua

---

*La presente Política entra en vigor desde su publicación en el sitio web del Servicio.*
