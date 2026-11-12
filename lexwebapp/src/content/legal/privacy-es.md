# POLÍTICA DE PRIVACIDAD

## Plataforma LEX AI

*Última actualización: 14 de marzo de 2026*

---

Empresario individual Kyrychenko Igor Viktorovych
NIF (RNOKPP): 2967214056
Dirección: 04207, Ucrania, Kyiv, calle Levka Lukianenka 19, apt. 110
Correo electrónico: info@legal.org.ua
Contacto de Protección de Datos: info@legal.org.ua

## 1. Introducción

La presente Política de Privacidad describe cómo Empresario individual Kyrychenko Igor Viktorovych (en adelante, la "Empresa", "nosotros") recopila, trata, almacena y protege los datos personales de los usuarios del servicio LEX AI (en adelante, el "Servicio").

La Empresa trata los datos personales de conformidad con:
- la Ley de Ucrania "Sobre la Protección de Datos Personales" (N.º 2297-VI);
- el Reglamento General de Protección de Datos (RGPD, Reglamento 2016/679) — para usuarios de la UE/EEE;
- otras normativas aplicables.

Al utilizar el Servicio, usted confirma que ha leído la presente Política y consiente el tratamiento de sus datos personales según se describe a continuación.

## 2. Datos que Recopilamos

**2.1. Datos que usted proporciona directamente:**
- nombre, apellidos, correo electrónico (durante el registro);
- foto de perfil (al autorizar mediante Google o Diia);
- documentos que carga para el análisis de IA;
- consultas de texto al sistema de IA;
- comentarios en artículos del blog.

**2.2. Datos recopilados automáticamente:**
- dirección IP y geolocalización aproximada;
- tipo de navegador y sistema operativo;
- hora y duración de la sesión;
- acciones dentro de la interfaz del Servicio (páginas visitadas, herramientas utilizadas);
- uso de la API (número de solicitudes, tipos de herramientas).

**2.3. Datos de terceros:**
- perfil de Google (nombre, correo electrónico, foto) — al autorizar mediante Google OAuth;
- datos de Diia.Firma (nombre completo, NIF) — al autorizar mediante Diia;
- información de pago de Monobank (estado de la transacción, sin número de tarjeta).

**2.4. Datos de abogados (para Abogados registrados en la Plataforma):**
- número y fecha de emisión de la Licencia para ejercer la abogacía;
- datos del Registro Único de Abogados de Ucrania (URAU);
- especialización, experiencia, biografía;
- datos bancarios (IBAN, nombre del banco) para los pagos;
- foto de perfil;
- tarifas y condiciones de servicio.

## 3. Finalidades del Tratamiento de Datos

Tratamos los datos personales para las siguientes finalidades:

**3.1. Prestación del Servicio:**
- creación y gestión de cuentas de usuario;
- realización de análisis de IA de documentos cargados;
- búsqueda semántica y recuperación de información jurídica;
- almacenamiento de documentos en la bóveda segura.

**3.2. Seguridad y calidad:**
- protección contra accesos no autorizados;
- supervisión de la calidad y el rendimiento del servicio;
- detección y prevención de abusos.

**3.3. Comunicación:**
- envío de notificaciones de servicio (confirmación de registro, restablecimiento de contraseña);
- notificación de cambios en las Condiciones o la Política.

**3.4. Obligaciones legales:**
- cumplimiento de requisitos legales;
- registros contables (datos de pago).

**3.5. Funcionamiento del Marketplace:**
- verificación del Abogado (verificación de datos en el URAU);
- transferencia de materiales del Cliente al Abogado (con el consentimiento explícito del Cliente al crear un Pedido);
- almacenamiento de registros de comunicación entre el Cliente y el Abogado (para la resolución de disputas y reclamaciones);
- procesamiento de pagos de depósito en garantía y pagos al Abogado;
- cálculo de valoraciones y moderación de reseñas.

## 4. Base Jurídica del Tratamiento (RGPD)

Para los usuarios de la UE/EEE, tratamos los datos sobre la base de:
- **Consentimiento** (Art. 6(1)(a) RGPD) — para funciones opcionales y marketing;
- **Ejecución de contrato** (Art. 6(1)(b) RGPD) — para la prestación del Servicio;
- **Interés legítimo** (Art. 6(1)(f) RGPD) — para la seguridad y la mejora del Servicio;
- **Obligación legal** (Art. 6(1)(c) RGPD) — para el cumplimiento de requisitos legales.

## 5. Tratamiento de Documentos mediante IA (Anthropic, OpenAI)

**IMPORTANTE:** Al utilizar el análisis de IA, el contenido de sus documentos y consultas se transmite a los proveedores de IA para su procesamiento.

El Servicio utiliza múltiples proveedores de IA:

**5.1. Proveedor principal — Anthropic (a través de AWS Bedrock):**
- los modelos Claude (Opus, Sonnet, Haiku) son la ruta principal para el procesamiento de consultas de IA;
- el acceso a los modelos de Anthropic se proporciona a través de AWS Bedrock (Amazon Web Services);
- los datos se procesan en servidores de AWS en la región de la UE (eu-central-1, Fráncfort);
- AWS Bedrock **NO** retiene datos de entrada o salida después del procesamiento;
- Anthropic **NO** utiliza los datos transmitidos a través de AWS Bedrock para entrenar sus modelos;
- el procesamiento se rige por un Acuerdo de Tratamiento de Datos (DPA) entre la Empresa y AWS;
- AWS posee las certificaciones SOC 2 Tipo 2, ISO 27001, ISO 27017 e ISO 27018.

**5.2. Proveedor secundario — OpenAI:**
- los modelos GPT-4o y GPT-4o-mini se utilizan como ruta auxiliar de procesamiento;
- el modelo text-embedding-3-small se utiliza para crear embeddings vectoriales;
- OpenAI actúa como subencargado y trata los datos exclusivamente según nuestras instrucciones;
- OpenAI **NO** utiliza los datos de la API para entrenar sus modelos (por defecto desde el 1 de marzo de 2023);
- los datos son retenidos por OpenAI durante un máximo de 30 días exclusivamente para la supervisión de abusos, tras lo cual se eliminan;
- el procesamiento se rige por un Acuerdo de Tratamiento de Datos (DPA) entre la Empresa y OpenAI;
- OpenAI posee la certificación SOC 2 Tipo 2.

Recomendaciones para los usuarios:
- no cargue documentos con datos personales especialmente sensibles (médicos, financieros) a menos que sea necesario para el análisis;
- anonimice los documentos antes de cargarlos cuando sea posible;
- contáctenos si requiere medidas de seguridad adicionales para el tratamiento de datos sensibles.

## 6. Almacenamiento y Seguridad de los Datos

**6.1. Dónde se almacenan los datos:**
- cuentas de usuario y metadatos — PostgreSQL (conexiones cifradas);
- documentos — MinIO (almacenamiento compatible con S3 con cifrado);
- embeddings vectoriales — Qdrant (para búsqueda semántica);
- caché de sesión — Redis (almacenamiento temporal).

**6.2. Medidas de seguridad:**
- cifrado de datos en tránsito (TLS 1.2+);
- cifrado de documentos de extremo a extremo (E2EE) a elección del Usuario — el contenido del documento se cifra en el navegador mediante AES-256-GCM, las claves se almacenan exclusivamente en el lado del Usuario (X25519 + Argon2id KDF), la Empresa no tiene la capacidad técnica de descifrar dichos documentos;
- autenticación mediante tokens JWT;
- control de acceso basado en roles;
- registro de auditoría con cadena de hash para el seguimiento de accesos;
- aislamiento de datos entre clientes (segregación por asuntos);
- copias de seguridad periódicas.

**6.2.1. Cifrado de Documentos de Extremo a Extremo (E2EE):**
A elección del Usuario, los documentos pueden protegerse con cifrado de extremo a extremo. En este caso:
- los metadatos del documento (título, tipo, fecha) se almacenan en texto plano para permitir la búsqueda y el filtrado;
- los embeddings semánticos se almacenan en Qdrant para la búsqueda semántica;
- el contenido del documento (texto completo) se cifra y almacena en forma cifrada;
- si se pierden la contraseña de cifrado y el archivo de clave de respaldo, el acceso a los documentos cifrados no puede recuperarse.

**6.3. Períodos de conservación:**
- datos de cuenta — duración de la cuenta + 30 días después de la eliminación;
- documentos cargados — duración de la cuenta, eliminados previa solicitud;
- registros de uso — 90 días;
- datos de pago — 5 años (requisito legal);
- datos de consultas de IA — hasta 30 días (supervisión de abusos de OpenAI; AWS Bedrock no retiene datos después del procesamiento);
- registros de comunicación del Marketplace — 12 meses desde la fecha de finalización del Pedido;
- datos de verificación del Abogado — duración de la cuenta del Abogado + 3 años;
- datos de transacciones de depósito en garantía — 5 años (requisito legal).

## 7. Compartición de Datos con Terceros

Compartimos datos personales exclusivamente con las siguientes categorías de destinatarios:

**7.1. Subencargados:**
- Amazon Web Services, Inc. (AWS Bedrock, UE/EE.UU.) — análisis principal de documentos y consultas mediante IA (modelos Anthropic Claude);
- OpenAI, LP (EE.UU.) — análisis auxiliar de IA y embeddings vectoriales;
- Monobank / JSC "Universal Bank" (Ucrania) — procesamiento de pagos;
- Cloudflare, Inc. (EE.UU.) — CDN y protección DDoS;
- Hetzner Online GmbH (Alemania) — alojamiento de servidores.

**7.1.1. Compartición de datos con Abogados:**
Los Abogados registrados en la Plataforma reciben acceso a los datos del Cliente exclusivamente en la medida determinada por el Cliente al crear un Pedido, y exclusivamente con el fin de prestar la Consulta jurídica. Tras la finalización del Pedido, el acceso del Abogado a los materiales del Cliente se revoca automáticamente después de 7 (siete) días naturales.

El Abogado es un responsable independiente de los datos personales del Cliente recibidos durante la prestación de la Consulta y está obligado a cumplir los requisitos del secreto profesional de conformidad con el artículo 22 de la Ley de Ucrania "Sobre la Abogacía y el Ejercicio de la Abogacía".

El personal de la Empresa no tiene acceso al contenido de las Consultas ni a los materiales del caso, excepto en los casos de revisión de reclamaciones con el consentimiento de ambas partes.

**7.2. Autoridades gubernamentales:**
- por orden judicial o solicitud legal de conformidad con la legislación ucraniana.

**NO** vendemos ni compartimos datos personales con fines de marketing de terceros.

Para las transferencias de datos fuera de la UE/EEE, utilizamos Cláusulas Contractuales Tipo (CCT) de conformidad con las decisiones de la Comisión Europea.

## 8. Sus Derechos

En virtud de la legislación aplicable y el RGPD, usted tiene los siguientes derechos:

- **Derecho de acceso** (Art. 15 RGPD) — obtener información sobre qué datos tratamos;
- **Derecho de rectificación** (Art. 16 RGPD) — corregir datos inexactos;
- **Derecho de supresión** (Art. 17 RGPD) — solicitar la eliminación completa de sus datos;
- **Derecho de limitación** (Art. 18 RGPD) — limitar el tratamiento de sus datos;
- **Derecho a la portabilidad** (Art. 20 RGPD) — recibir sus datos en un formato estructurado;
- **Derecho de oposición** (Art. 21 RGPD) — oponerse al tratamiento basado en interés legítimo;
- **Derecho a retirar el consentimiento** — en cualquier momento sin afectar la legalidad del tratamiento anterior.

Para ejercer estos derechos:
- Exportación de datos: Perfil → Privacidad y Datos → Exportar;
- Eliminación de cuenta: Perfil → Privacidad y Datos → Eliminar;
- Otras solicitudes: info@legal.org.ua.

Respondemos a las solicitudes en un plazo de 30 días.

También tiene derecho a presentar una reclamación ante el Comisionado del Parlamento de Ucrania para los Derechos Humanos (Ucrania) o ante la autoridad de supervisión de su país de la UE.

8.1. **API de Portabilidad de Datos.** El Cliente puede utilizar el método de la API REST `POST /api/user/export` para obtener sus datos en un formato legible por máquina (JSON). La exportación incluye: perfil, documentos cargados, historial de consultas de IA, resultados de análisis, historial de Pedidos y registros de uso.

## 9. Toma de Decisiones Automatizada

9.1. De conformidad con el Art. 22 del RGPD, el Servicio NO toma decisiones con efectos jurídicos sobre el Cliente basándose exclusivamente en el tratamiento automatizado, incluida la elaboración de perfiles.

9.2. Los resultados del análisis de IA son únicamente asistencia informativa y no sustituyen el asesoramiento jurídico profesional. Ninguna decisión de la Plataforma (incluidas las valoraciones, la moderación, los pagos del depósito en garantía) es completamente automatizada — todas las decisiones materiales prevén la posibilidad de intervención humana.

9.3. El Cliente tiene derecho a solicitar la revisión humana de cualquier decisión que afecte a sus derechos contactando con info@legal.org.ua.

## 10. Evaluación de Interés Legítimo

10.1. La Empresa trata determinadas categorías de datos sobre la base del interés legítimo (Art. 6(1)(f) RGPD) para las siguientes finalidades:
- garantizar la seguridad del Servicio y la prevención del fraude;
- mejorar la calidad del Servicio basándose en analíticas agregadas;
- detectar y prevenir abusos.

10.2. La Empresa ha realizado una Evaluación de Interés Legítimo y ha determinado que dicho tratamiento no prevalece sobre los derechos y libertades de los interesados.

10.3. El Cliente tiene derecho a solicitar una copia de la Evaluación de Interés Legítimo contactando con info@legal.org.ua.

## 11. Cookies

El Servicio utiliza:
- **cookies esenciales** — para la autenticación y el soporte de sesión (tokens JWT);
- **cookies funcionales** — para almacenar la configuración de idioma y las preferencias de la interfaz.

**NO** utilizamos cookies de publicidad ni de analíticas de terceros. **NO** realizamos seguimiento de los usuarios en otros sitios web.

## 12. Protección de Datos de Menores

El Servicio no está destinado a personas menores de 18 años. No recopilamos deliberadamente datos personales de menores. Si cree que un menor nos ha proporcionado sus datos, contáctenos para su eliminación.

## 13. Cambios en la Presente Política

Podemos actualizar la presente Política de Privacidad. Le notificaremos de los cambios sustanciales:
- por correo electrónico registrado en su cuenta;
- mediante notificaciones en la interfaz del Servicio;
- con al menos 14 días de antelación antes de que los cambios entren en vigor.

El uso continuado del Servicio después de los cambios constituye la aceptación de la Política actualizada.

## 14. Calidad y Seguridad de la IA

La Empresa implementa medidas integrales para garantizar la calidad y seguridad del tratamiento de datos mediante IA:

**14.1. Supervisión Continua:**
- supervisión automatizada en tiempo real de la calidad de las respuestas de IA;
- seguimiento de las métricas de exactitud de citas y referencias mediante el sistema CitationValidator;
- supervisión del rendimiento de HallucinationGuard para prevenir la generación de información incorrecta.

**14.2. Ciclo de Retroalimentación del Usuario:**
- los Usuarios pueden informar sobre resultados incorrectos del análisis de IA;
- cada informe se analiza para mejorar la calidad del Servicio;
- análisis sistemático de la retroalimentación para mejorar los mecanismos de seguridad.

**14.3. Pruebas Periódicas:**
- pruebas periódicas de los mecanismos HallucinationGuard y CitationValidator con datos jurídicos actuales;
- verificación de la exactitud de la búsqueda semántica y la relevancia de los resultados;
- evaluación de la eficacia de la protección contra errores de IA.

**14.4. Auditorías de Seguridad:**
- auditorías internas periódicas de los procedimientos de tratamiento de datos de IA;
- verificación del cumplimiento de los estándares de protección de datos personales;
- Evaluación de Impacto en la Protección de Datos (EIPD) al implementar nuevas funciones de IA.

Para consultas sobre calidad y seguridad de la IA, contacte: info@legal.org.ua

## 15. Datos de Contacto

Para consultas sobre protección de datos, contacte:

Empresario individual Kyrychenko Igor Viktorovych
NIF (RNOKPP): 2967214056
Dirección: 04207, Ucrania, Kyiv, calle Levka Lukianenka 19, apt. 110
Correo electrónico: info@legal.org.ua
Sitio web: https://legal.org.ua
