/**
 * Centralized i18n system for toast messages.
 * Reads locale from localStorage ('lex_locale') via getLocale().
 * Works outside React components (no hooks).
 */

import { getLocale } from './locales';

/* ────────────────────────────────────────────────────────────
 * Static toast translations
 * ──────────────────────────────────────────────────────────── */

const toastMessages = {
  // ── General / Clipboard ──
  copied: { uk: 'Скопійовано', es: 'Copiado', en: 'Copied', de: 'Kopiert' },
  copyFailed: { uk: 'Не вдалося скопіювати', es: 'No se pudo copiar', en: 'Failed to copy', de: 'Kopieren fehlgeschlagen' },
  comingSoon: { uk: 'Скоро буде доступно', es: 'Próximamente disponible', en: 'Coming soon', de: 'Bald verfügbar' },

  // ── Auth ──
  loggedOut: { uk: 'Ви вийшли з системи', es: 'Ha cerrado sesión', en: 'You have been logged out', de: 'Sie wurden abgemeldet' },
  loginSuccess: { uk: 'Вхід виконано успішно!', es: '¡Inicio de sesión exitoso!', en: 'Login successful!', de: 'Anmeldung erfolgreich!' },
  loginError: { uk: 'Помилка входу', es: 'Error de inicio de sesión', en: 'Login error', de: 'Anmeldefehler' },
  turnstileRequired: {
    uk: 'Підтвердіть, що ви не робот',
    es: 'Confirme que no es un robot',
    en: 'Please confirm you are not a robot',
    de: 'Bitte bestätigen Sie, dass Sie kein Roboter sind',
  },
  passwordLeaked: {
    uk: 'Цей пароль є у відомих витоках даних. Змініть його: вийдіть і скористайтесь «Забули пароль?».',
    es: 'Esta contraseña aparece en filtraciones de datos conocidas. Cámbiela: cierre sesión y use «¿Olvidó su contraseña?».',
    en: 'This password appears in known data breaches. Change it: sign out and use "Forgot password?".',
    de: 'Dieses Passwort stammt aus bekannten Datenlecks. Ändern Sie es: abmelden und „Passwort vergessen?“ nutzen.',
  },
  ssoLoginSuccess: { uk: 'Вхід через SSO виконано успішно!', es: '¡Inicio de sesión SSO exitoso!', en: 'SSO login successful!', de: 'SSO-Anmeldung erfolgreich!' },
  ssoError: { uk: 'Помилка SSO', es: 'Error de SSO', en: 'SSO error', de: 'SSO-Fehler' },
  registrationSuccess: {
    uk: 'Реєстрацію завершено! Перевірте email для підтвердження акаунту.',
    es: '¡Registro completado! Revise su correo para confirmar la cuenta.',
    en: 'Registration complete! Check your email to confirm your account.',
    de: 'Registrierung abgeschlossen! Überprüfen Sie Ihre E-Mail zur Kontobestätigung.',
  },
  registrationError: { uk: 'Помилка реєстрації', es: 'Error de registro', en: 'Registration error', de: 'Registrierungsfehler' },
  authError: { uk: 'Помилка автентифікації', es: 'Error de autenticación', en: 'Authentication error', de: 'Authentifizierungsfehler' },

  // ── Network / Server ──
  networkError: {
    uk: 'Помилка мережі. Перевірте підключення.',
    es: 'Error de red. Verifique su conexión.',
    en: 'Network error. Please check your connection.',
    de: 'Netzwerkfehler. Bitte überprüfen Sie Ihre Verbindung.',
  },
  sessionExpired: {
    uk: 'Сесія закінчилась. Увійдіть знову.',
    es: 'La sesión ha expirado. Inicie sesión nuevamente.',
    en: 'Session expired. Please login again.',
    de: 'Sitzung abgelaufen. Bitte melden Sie sich erneut an.',
  },
  serverError: {
    uk: 'Помилка сервера. Спробуйте пізніше.',
    es: 'Error del servidor. Inténtelo más tarde.',
    en: 'Server error. Please try again later.',
    de: 'Serverfehler. Bitte versuchen Sie es später erneut.',
  },
  genericError: {
    uk: 'Сталася помилка. Спробуйте ще раз.',
    es: 'Se produjo un error. Inténtelo de nuevo.',
    en: 'An error occurred. Please try again.',
    de: 'Ein Fehler ist aufgetreten. Bitte versuchen Sie es erneut.',
  },

  // ── Password ──
  passwordResetSuccess: { uk: 'Пароль успішно скинуто!', es: '¡Contraseña restablecida exitosamente!', en: 'Password reset successfully!', de: 'Passwort erfolgreich zurückgesetzt!' },
  passwordResetError: { uk: 'Помилка скидання паролю', es: 'Error al restablecer la contraseña', en: 'Password reset error', de: 'Fehler beim Zurücksetzen des Passworts' },

  // ── Email verification ──
  emailVerified: { uk: 'Email підтверджено!', es: '¡Correo verificado!', en: 'Email verified!', de: 'E-Mail verifiziert!' },
  verificationFailed: { uk: 'Помилка верифікації', es: 'Error de verificación', en: 'Verification failed', de: 'Verifizierung fehlgeschlagen' },

  // ── Sidebar / Folders ──
  folderDeleted: { uk: 'Папку видалено', es: 'Carpeta eliminada', en: 'Folder deleted', de: 'Ordner gelöscht' },
  folderDeleteFailed: { uk: 'Не вдалося видалити папку', es: 'No se pudo eliminar la carpeta', en: 'Failed to delete folder', de: 'Ordner konnte nicht gelöscht werden' },

  // ── Legal Codes ──
  loadingStructure: { uk: 'Завантаження структури...', es: 'Cargando estructura...', en: 'Loading structure...', de: 'Struktur wird geladen...' },
  loaded: { uk: 'Завантажено', es: 'Cargado', en: 'Loaded', de: 'Geladen' },
  linkUnavailable: { uk: 'Посилання недоступне', es: 'Enlace no disponible', en: 'Link unavailable', de: 'Link nicht verfügbar' },
  linkCopied: { uk: 'Посилання скопійовано', es: 'Enlace copiado', en: 'Link copied', de: 'Link kopiert' },

  // ── Billing / Settings ──
  settingsLoadFailed: { uk: 'Не вдалося завантажити налаштування', es: 'No se pudieron cargar los ajustes', en: 'Failed to load settings', de: 'Einstellungen konnten nicht geladen werden' },
  paymentMethodDeleted: { uk: 'Спосіб оплати видалено', es: 'Método de pago eliminado', en: 'Payment method deleted', de: 'Zahlungsmethode gelöscht' },
  paymentMethodDeleteFailed: { uk: 'Не вдалося видалити спосіб оплати', es: 'No se pudo eliminar el método de pago', en: 'Failed to delete payment method', de: 'Zahlungsmethode konnte nicht gelöscht werden' },
  defaultPaymentUpdated: { uk: 'Основний спосіб оплати оновлено', es: 'Método de pago principal actualizado', en: 'Default payment method updated', de: 'Standard-Zahlungsmethode aktualisiert' },
  defaultPaymentUpdateFailed: { uk: 'Не вдалося оновити основний спосіб оплати', es: 'No se pudo actualizar el método de pago principal', en: 'Failed to update default payment method', de: 'Standard-Zahlungsmethode konnte nicht aktualisiert werden' },
  billingInfoSaved: { uk: 'Платіжну інформацію збережено', es: 'Información de facturación guardada', en: 'Billing information saved', de: 'Zahlungsinformationen gespeichert' },
  billingInfoSaveFailed: { uk: 'Не вдалося зберегти платіжну інформацію', es: 'No se pudo guardar la información de facturación', en: 'Failed to save billing information', de: 'Zahlungsinformationen konnten nicht gespeichert werden' },
  limitsUpdated: { uk: 'Ліміти оновлено', es: 'Límites actualizados', en: 'Limits updated', de: 'Limits aktualisiert' },
  limitsUpdateFailed: { uk: 'Не вдалося оновити ліміти', es: 'No se pudieron actualizar los límites', en: 'Failed to update limits', de: 'Limits konnten nicht aktualisiert werden' },
  testEmailSent: { uk: 'Тестовий лист надіслано! Перевірте вхідні.', es: '¡Correo de prueba enviado! Revise su bandeja de entrada.', en: 'Test email sent! Check your inbox.', de: 'Test-E-Mail gesendet! Überprüfen Sie Ihr Postfach.' },
  balanceLoadFailed: { uk: 'Не вдалося завантажити дані балансу', es: 'No se pudieron cargar los datos del saldo', en: 'Failed to load balance data', de: 'Kontodaten konnten nicht geladen werden' },
  statisticsLoadFailed: { uk: 'Не вдалося завантажити статистику', es: 'No se pudieron cargar las estadísticas', en: 'Failed to load statistics', de: 'Statistiken konnten nicht geladen werden' },
  csvDownloaded: { uk: 'CSV-файл завантажено', es: 'Archivo CSV descargado', en: 'CSV file downloaded', de: 'CSV-Datei heruntergeladen' },
  transactionsLoadFailed: { uk: 'Не вдалося завантажити історію транзакцій', es: 'No se pudo cargar el historial de transacciones', en: 'Failed to load transaction history', de: 'Transaktionshistorie konnte nicht geladen werden' },
  transactionsExported: { uk: 'Транзакції експортовано у CSV', es: 'Transacciones exportadas a CSV', en: 'Transactions exported to CSV', de: 'Transaktionen als CSV exportiert' },
  invoicesLoadFailed: { uk: 'Не вдалося завантажити рахунки', es: 'No se pudieron cargar las facturas', en: 'Failed to load invoices', de: 'Rechnungen konnten nicht geladen werden' },
  invoicePdfFailed: { uk: 'Не вдалося створити PDF рахунку', es: 'No se pudo crear el PDF de la factura', en: 'Failed to create invoice PDF', de: 'Rechnungs-PDF konnte nicht erstellt werden' },
  tariffChangeFailed: { uk: 'Не вдалося змінити тариф', es: 'No se pudo cambiar la tarifa', en: 'Failed to change plan', de: 'Tarifwechsel fehlgeschlagen' },
  contractsLoadFailed: { uk: 'Не вдалося завантажити договори', es: 'No se pudieron cargar los contratos', en: 'Failed to load contracts', de: 'Verträge konnten nicht geladen werden' },

  // ── TopUp / Payments ──
  paymentConfirmed: { uk: 'Оплату підтверджено!', es: '¡Pago confirmado!', en: 'Payment confirmed!', de: 'Zahlung bestätigt!' },
  paymentConfirmedBalanceUpdated: { uk: 'Оплату підтверджено! Баланс оновлено.', es: '¡Pago confirmado! Saldo actualizado.', en: 'Payment confirmed! Balance updated.', de: 'Zahlung bestätigt! Saldo aktualisiert.' },
  transactionSent: { uk: 'Транзакцію відправлено. Верифікація...', es: 'Transacción enviada. Verificando...', en: 'Transaction sent. Verifying...', de: 'Transaktion gesendet. Verifizierung...' },
  transactionProcessing: { uk: 'Транзакція ще обробляється.', es: 'La transacción aún se está procesando.', en: 'Transaction still processing.', de: 'Transaktion wird noch verarbeitet.' },
  addressCopied: { uk: 'Адресу скопійовано', es: 'Dirección copiada', en: 'Address copied', de: 'Adresse kopiert' },
  binancePayConfirmed: { uk: 'Binance Pay оплату підтверджено!', es: '¡Pago Binance Pay confirmado!', en: 'Binance Pay payment confirmed!', de: 'Binance Pay Zahlung bestätigt!' },

  // ── Attorney / Invitations ──
  invalidFeeAmount: { uk: 'Вкажіть коректну суму гонорару', es: 'Indique un importe de honorarios válido', en: 'Enter a valid fee amount', de: 'Geben Sie einen gültigen Honorarbetrag ein' },
  requestAccepted: { uk: 'Запит прийнято', es: 'Solicitud aceptada', en: 'Request accepted', de: 'Anfrage angenommen' },
  requestAcceptFailed: { uk: 'Не вдалося прийняти запит', es: 'No se pudo aceptar la solicitud', en: 'Failed to accept request', de: 'Anfrage konnte nicht angenommen werden' },
  requestDeclined: { uk: 'Запит відхилено', es: 'Solicitud rechazada', en: 'Request declined', de: 'Anfrage abgelehnt' },
  requestDeclineFailed: { uk: 'Не вдалося відхилити запит', es: 'No se pudo rechazar la solicitud', en: 'Failed to decline request', de: 'Anfrage konnte nicht abgelehnt werden' },

  // ── Prompts ──
  promptsLoadFailed: { uk: 'Не вдалося завантажити промпти', es: 'No se pudieron cargar los prompts', en: 'Failed to load prompts', de: 'Prompts konnten nicht geladen werden' },
  promptDeleteFailed: { uk: 'Не вдалося видалити промпт', es: 'No se pudo eliminar el prompt', en: 'Failed to delete prompt', de: 'Prompt konnte nicht gelöscht werden' },
  promptFavoriteFailed: { uk: 'Не вдалося оновити обране', es: 'No se pudo actualizar favoritos', en: 'Failed to update favorite', de: 'Favorit konnte nicht aktualisiert werden' },
  promptSaved: { uk: 'Промпт збережено', es: 'Prompt guardado', en: 'Prompt saved', de: 'Prompt gespeichert' },
  promptSaveFailed: { uk: 'Не вдалося зберегти промпт', es: 'No se pudo guardar el prompt', en: 'Failed to save prompt', de: 'Prompt konnte nicht gespeichert werden' },

  // ── Messages / Chat ──
  removedFromFavorites: { uk: 'Вилучено з обраного', es: 'Eliminado de favoritos', en: 'Removed from favorites', de: 'Aus Favoriten entfernt' },
  savedToFavorites: { uk: 'Збережено в обране', es: 'Guardado en favoritos', en: 'Saved to favorites', de: 'Zu Favoriten hinzugefügt' },
  feedbackThankYou: { uk: 'Дякуємо за відгук!', es: '¡Gracias por su comentario!', en: 'Thank you for your feedback!', de: 'Danke für Ihr Feedback!' },
  feedbackNoted: { uk: 'Дякуємо, врахуємо', es: 'Gracias, lo tendremos en cuenta', en: 'Thank you, we will take it into account', de: 'Danke, wir berücksichtigen es' },
  enterSearchQuery: { uk: 'Введіть пошуковий запит', es: 'Introduzca una consulta de búsqueda', en: 'Enter a search query', de: 'Geben Sie eine Suchanfrage ein' },
  allDecisionsLoaded: { uk: 'Всі рішення вже завантажено', es: 'Todas las resoluciones ya están cargadas', en: 'All decisions already loaded', de: 'Alle Entscheidungen bereits geladen' },

  // ── Documents ──
  documentCopied: { uk: 'Документ скопійовано', es: 'Documento copiado', en: 'Document copied', de: 'Dokument kopiert' },
  generatingPdf: { uk: 'Генерую PDF...', es: 'Generando PDF...', en: 'Generating PDF...', de: 'PDF wird generiert...' },
  allowPopupsForPdf: { uk: 'Дозвольте спливаючі вікна для збереження PDF', es: 'Permita ventanas emergentes para guardar el PDF', en: 'Allow popups to save PDF', de: 'Popups zum Speichern des PDFs erlauben' },
  pdfCreationError: { uk: 'Помилка при створенні PDF', es: 'Error al crear el PDF', en: 'Error creating PDF', de: 'Fehler beim Erstellen des PDF' },
  generatingDocx: { uk: 'Генерую DOCX...', es: 'Generando DOCX...', en: 'Generating DOCX...', de: 'DOCX wird generiert...' },
  docxSaved: { uk: 'DOCX збережено', es: 'DOCX guardado', en: 'DOCX saved', de: 'DOCX gespeichert' },
  docxCreationError: { uk: 'Помилка при створенні DOCX', es: 'Error al crear el DOCX', en: 'Error creating DOCX', de: 'Fehler beim Erstellen des DOCX' },
  documentSaved: { uk: 'Документ збережено', es: 'Documento guardado', en: 'Document saved', de: 'Dokument gespeichert' },
  documentDownloadFailed: { uk: 'Не вдалося завантажити документ', es: 'No se pudo descargar el documento', en: 'Failed to download document', de: 'Dokument konnte nicht heruntergeladen werden' },
  documentMoveFailed: { uk: 'Не вдалося перемістити документ', es: 'No se pudo mover el documento', en: 'Failed to move document', de: 'Dokument konnte nicht verschoben werden' },
  textSaved: { uk: 'Текст збережено', es: 'Texto guardado', en: 'Text saved', de: 'Text gespeichert' },
  documentDeleteFailed: { uk: 'Не вдалося видалити документ', es: 'No se pudo eliminar el documento', en: 'Failed to delete document', de: 'Dokument konnte nicht gelöscht werden' },
  previewLoadFailed: { uk: 'Не вдалося завантажити попередній перегляд', es: 'No se pudo cargar la vista previa', en: 'Failed to load preview', de: 'Vorschau konnte nicht geladen werden' },
  pressDeleteToConfirm: { uk: 'Натисніть Delete ще раз для підтвердження', es: 'Presione Eliminar de nuevo para confirmar', en: 'Press Delete again to confirm', de: 'Drücken Sie erneut Entf zum Bestätigen' },
  uploadFilesError: { uk: 'Помилка завантаження файлів', es: 'Error al cargar archivos', en: 'File upload error', de: 'Fehler beim Hochladen von Dateien' },
  encryptionKeyRequired: { uk: 'Для завантаження документів потрібно створити ключ шифрування', es: 'Se requiere crear una clave de cifrado para cargar documentos', en: 'Encryption key required to upload documents', de: 'Verschlüsselungsschlüssel zum Hochladen von Dokumenten erforderlich' },
  unlockEncryption: { uk: 'Розблокуйте шифрування для завантаження документів', es: 'Desbloquee el cifrado para cargar documentos', en: 'Unlock encryption to upload documents', de: 'Verschlüsselung zum Hochladen von Dokumenten entsperren' },
  selectMatter: { uk: 'Оберіть справу', es: 'Seleccione un expediente', en: 'Select a matter', de: 'Wählen Sie eine Akte' },
  selectFolder: { uk: 'Оберіть папку', es: 'Seleccione una carpeta', en: 'Select a folder', de: 'Wählen Sie einen Ordner' },
  saveFailed: { uk: 'Не вдалося зберегти. Спробуйте ще раз.', es: 'No se pudo guardar. Inténtelo de nuevo.', en: 'Failed to save. Please try again.', de: 'Speichern fehlgeschlagen. Bitte versuchen Sie es erneut.' },
  classificationAllDone: { uk: 'Всі документи вже класифіковані', es: 'Todos los documentos ya están clasificados', en: 'All documents already classified', de: 'Alle Dokumente sind bereits klassifiziert' },
  classificationStartFailed: { uk: 'Не вдалося запустити класифікацію', es: 'No se pudo iniciar la clasificación', en: 'Failed to start classification', de: 'Klassifizierung konnte nicht gestartet werden' },
  classificationCancelled: { uk: 'Класифікацію скасовано', es: 'Clasificación cancelada', en: 'Classification cancelled', de: 'Klassifizierung abgebrochen' },
  classificationCancelFailed: { uk: 'Не вдалося скасувати', es: 'No se pudo cancelar', en: 'Failed to cancel', de: 'Abbrechen fehlgeschlagen' },
  queueClearFailed: { uk: 'Не вдалося очистити чергу', es: 'No se pudo vaciar la cola', en: 'Failed to clear queue', de: 'Warteschlange konnte nicht geleert werden' },
  someDocumentsDeleteFailed: { uk: 'Не вдалося видалити деякі документи', es: 'No se pudieron eliminar algunos documentos', en: 'Failed to delete some documents', de: 'Einige Dokumente konnten nicht gelöscht werden' },
  documentAccessRevoked: { uk: 'Доступ до документа відкликано', es: 'Acceso al documento revocado', en: 'Document access revoked', de: 'Dokumentzugriff widerrufen' },
  documentAccessRevokeFailed: { uk: 'Не вдалося відкликати доступ', es: 'No se pudo revocar el acceso', en: 'Failed to revoke access', de: 'Zugriff konnte nicht widerrufen werden' },

  // ── Consultation ──
  consultationAccepted: { uk: 'Консультацію прийнято', es: 'Consulta aceptada', en: 'Consultation accepted', de: 'Beratung angenommen' },
  consultationDeclined: { uk: 'Консультацію відхилено', es: 'Consulta rechazada', en: 'Consultation declined', de: 'Beratung abgelehnt' },
  consultationStarted: { uk: 'Консультацію розпочато', es: 'Consulta iniciada', en: 'Consultation started', de: 'Beratung gestartet' },
  consultationCompleted: { uk: 'Консультацію завершено', es: 'Consulta completada', en: 'Consultation completed', de: 'Beratung abgeschlossen' },
  consultationCancelled: { uk: 'Консультацію скасовано', es: 'Consulta cancelada', en: 'Consultation cancelled', de: 'Beratung storniert' },
  monobankPaymentFailed: { uk: 'Не вдалося отримати посилання на оплату від Monobank', es: 'No se pudo obtener el enlace de pago de Monobank', en: 'Failed to get Monobank payment link', de: 'Monobank-Zahlungslink konnte nicht abgerufen werden' },
  thankYouForFeedback: { uk: 'Дякуємо за відгук!', es: '¡Gracias por su comentario!', en: 'Thank you for your feedback!', de: 'Danke für Ihr Feedback!' },

  // ── Legislation Monitoring ──
  subscriptionCancelled: { uk: 'Підписку скасовано', es: 'Suscripción cancelada', en: 'Subscription cancelled', de: 'Abonnement gekündigt' },
  subscribedToChanges: { uk: 'Підписано на зміни', es: 'Suscrito a cambios', en: 'Subscribed to changes', de: 'Änderungen abonniert' },
  subscriptionChangeFailed: { uk: 'Не вдалося змінити підписку', es: 'No se pudo cambiar la suscripción', en: 'Failed to change subscription', de: 'Abonnement konnte nicht geändert werden' },

  // ── Profile ──
  profileUpdated: { uk: 'Профіль успішно оновлено', es: 'Perfil actualizado exitosamente', en: 'Profile updated successfully', de: 'Profil erfolgreich aktualisiert' },
  profileUpdateFailed: { uk: 'Не вдалося оновити профіль', es: 'No se pudo actualizar el perfil', en: 'Failed to update profile', de: 'Profil konnte nicht aktualisiert werden' },
  unsupportedImageFormat: { uk: 'Непідтримуваний формат зображення', es: 'Formato de imagen no compatible', en: 'Unsupported image format', de: 'Nicht unterstütztes Bildformat' },
  fileSizeExceeds10MB: { uk: 'Розмір файлу не повинен перевищувати 10MB', es: 'El archivo no debe superar los 10MB', en: 'File size must not exceed 10MB', de: 'Dateigröße darf 10MB nicht überschreiten' },
  profilePhotoUpdated: { uk: 'Фото профілю оновлено', es: 'Foto de perfil actualizada', en: 'Profile photo updated', de: 'Profilfoto aktualisiert' },
  profilePhotoUploadFailed: { uk: 'Не вдалося завантажити фото', es: 'No se pudo cargar la foto', en: 'Failed to upload photo', de: 'Foto konnte nicht hochgeladen werden' },
  securityKeyRegistered: { uk: 'Ключ безпеки зареєстровано!', es: '¡Clave de seguridad registrada!', en: 'Security key registered!', de: 'Sicherheitsschlüssel registriert!' },
  registrationCancelled: { uk: 'Реєстрацію скасовано', es: 'Registro cancelado', en: 'Registration cancelled', de: 'Registrierung abgebrochen' },
  keyDeleted: { uk: 'Ключ видалено', es: 'Clave eliminada', en: 'Key deleted', de: 'Schlüssel gelöscht' },
  keyDeleteFailed: { uk: 'Не вдалося видалити ключ', es: 'No se pudo eliminar la clave', en: 'Failed to delete key', de: 'Schlüssel konnte nicht gelöscht werden' },
  enterTokenName: { uk: 'Введіть назву токена', es: 'Introduzca el nombre del token', en: 'Enter token name', de: 'Token-Name eingeben' },
  tokenCreateFailed: { uk: 'Не вдалося створити токен', es: 'No se pudo crear el token', en: 'Failed to create token', de: 'Token konnte nicht erstellt werden' },
  tokenRevoked: { uk: 'Токен відкликано', es: 'Token revocado', en: 'Token revoked', de: 'Token widerrufen' },
  tokenRevokeFailed: { uk: 'Не вдалося відкликати токен', es: 'No se pudo revocar el token', en: 'Failed to revoke token', de: 'Token konnte nicht widerrufen werden' },

  // ── Referral ──
  fillAllFields: { uk: 'Заповніть всі поля', es: 'Complete todos los campos', en: 'Fill in all fields', de: 'Füllen Sie alle Felder aus' },
  verificationPassed: { uk: 'Верифікацію пройдено', es: 'Verificación completada', en: 'Verification passed', de: 'Verifizierung bestanden' },
  referralVerificationFailed: { uk: 'Не вдалося пройти верифікацію', es: 'No se pudo completar la verificación', en: 'Verification failed', de: 'Verifizierung fehlgeschlagen' },
  dataLoadFailed: { uk: 'Не вдалося завантажити дані', es: 'No se pudieron cargar los datos', en: 'Failed to load data', de: 'Daten konnten nicht geladen werden' },
  codeCopied: { uk: 'Код скопійовано', es: 'Código copiado', en: 'Code copied', de: 'Code kopiert' },

  // ── Undo ──
  undoFailed: { uk: 'Не вдалося скасувати дію', es: 'No se pudo deshacer la acción', en: 'Failed to undo action', de: 'Aktion konnte nicht rückgängig gemacht werden' },
  redoFailed: { uk: 'Не вдалося повторити дію', es: 'No se pudo rehacer la acción', en: 'Failed to redo action', de: 'Aktion konnte nicht wiederholt werden' },

  // ── GDPR ──
  dataExportRequested: { uk: 'Запит на експорт даних надіслано. Перевірте пізніше.', es: 'Solicitud de exportación enviada. Revise más tarde.', en: 'Data export requested. Check back shortly.', de: 'Datenexport angefordert. Schauen Sie in Kürze nach.' },
  dataExportRequestFailed: { uk: 'Не вдалося надіслати запит на експорт', es: 'No se pudo solicitar la exportación', en: 'Failed to request data export', de: 'Datenexport konnte nicht angefordert werden' },
  dataDownloaded: { uk: 'Дані завантажено', es: 'Datos descargados', en: 'Data downloaded', de: 'Daten heruntergeladen' },
  exportStillProcessing: { uk: 'Експорт ще обробляється. Спробуйте через хвилину.', es: 'La exportación aún se está procesando. Inténtelo en un minuto.', en: 'Export is still processing. Try again in a minute.', de: 'Export wird noch verarbeitet. Versuchen Sie es in einer Minute erneut.' },
  exportNotAvailable: { uk: 'Експорт недоступний', es: 'Exportación no disponible', en: 'Export not available', de: 'Export nicht verfügbar' },
  exportDownloadFailed: { uk: 'Не вдалося завантажити експорт', es: 'No se pudo descargar la exportación', en: 'Failed to download export', de: 'Export konnte nicht heruntergeladen werden' },
  accountDeletionInitiated: { uk: 'Запит на видалення акаунту надіслано. Всі дані буде видалено.', es: 'Solicitud de eliminación de cuenta enviada. Todos los datos serán eliminados.', en: 'Account deletion initiated. All data will be removed.', de: 'Kontolöschung eingeleitet. Alle Daten werden entfernt.' },
  accountDeletionFailed: { uk: 'Не вдалося надіслати запит на видалення', es: 'No se pudo solicitar la eliminación de la cuenta', en: 'Failed to request account deletion', de: 'Kontolöschung konnte nicht angefordert werden' },

  // ── Undoable button text ──
  undoAction: { uk: 'Скасувати', es: 'Deshacer', en: 'Undo', de: 'Rückgängig' },
} as const;

export type ToastKey = keyof typeof toastMessages;

/**
 * Get a translated toast message for the current locale.
 * Falls back to Ukrainian if locale not found.
 */
export function toastT(key: ToastKey): string {
  const locale = getLocale();
  const entry = toastMessages[key];
  return entry[locale] ?? entry.uk;
}

/* ────────────────────────────────────────────────────────────
 * Dynamic toast translations (with interpolation)
 * ──────────────────────────────────────────────────────────── */

const dynamicMessages = {
  welcomeUser: {
    uk: (name: string) => `Вітаємо, ${name}!`,
    es: (name: string) => `¡Bienvenido/a, ${name}!`,
    en: (name: string) => `Welcome, ${name}!`,
    de: (name: string) => `Willkommen, ${name}!`,
  },
  pendingConsultationRequests: {
    uk: (count: number, word: string) => `У вас ${count} ${word} на консультацію`,
    es: (count: number) => `Tiene ${count} ${count === 1 ? 'nueva solicitud' : 'nuevas solicitudes'} de consulta`,
    en: (count: number) => `You have ${count} new consultation ${count === 1 ? 'request' : 'requests'}`,
    de: (count: number) => `Sie haben ${count} neue Beratungs${count === 1 ? 'anfrage' : 'anfragen'}`,
  },
  newConsultationRequest: {
    uk: (title: string) => `Новий запит на консультацію: ${title || 'без назви'}`,
    es: (title: string) => `Nueva solicitud de consulta: ${title || 'sin título'}`,
    en: (title: string) => `New consultation request: ${title || 'untitled'}`,
    de: (title: string) => `Neue Beratungsanfrage: ${title || 'ohne Titel'}`,
  },
  testPaymentSuccess: {
    uk: (amount: string) => `Тестова оплата ${amount} UAH успішна!`,
    es: (amount: string) => `¡Pago de prueba de ${amount} UAH exitoso!`,
    en: (amount: string) => `Test payment of ${amount} UAH successful!`,
    de: (amount: string) => `Testzahlung von ${amount} UAH erfolgreich!`,
  },
  testCryptoPaymentCreated: {
    uk: (amount: string) => `Тестова крипто-оплата $${amount} створена!`,
    es: (amount: string) => `¡Pago de prueba con criptomoneda de $${amount} creado!`,
    en: (amount: string) => `Test crypto payment of $${amount} created!`,
    de: (amount: string) => `Krypto-Testzahlung von $${amount} erstellt!`,
  },
  testBinancePayCreated: {
    uk: (amount: string) => `Тестове замовлення Binance Pay $${amount} створено!`,
    es: (amount: string) => `¡Pedido de prueba Binance Pay de $${amount} creado!`,
    en: (amount: string) => `Test Binance Pay order of $${amount} created!`,
    de: (amount: string) => `Binance Pay Testbestellung von $${amount} erstellt!`,
  },
  invoiceDownloaded: {
    uk: (num: string) => `Рахунок ${num} завантажено`,
    es: (num: string) => `Factura ${num} descargada`,
    en: (num: string) => `Invoice ${num} downloaded`,
    de: (num: string) => `Rechnung ${num} heruntergeladen`,
  },
  tariffActivated: {
    uk: (name: string) => `Тариф ${name} успішно активовано`,
    es: (name: string) => `Tarifa ${name} activada exitosamente`,
    en: (name: string) => `Plan ${name} activated successfully`,
    de: (name: string) => `Tarif ${name} erfolgreich aktiviert`,
  },
  tariffActivatedWithRefund: {
    uk: (name: string, refund: number) => `Тариф ${name} активовано. Повернено ${Math.round(refund)} ₴ на баланс`,
    es: (name: string, refund: number) => `Tarifa ${name} activada. ${Math.round(refund)} ₴ devueltos al saldo`,
    en: (name: string, refund: number) => `Plan ${name} activated. ${Math.round(refund)} ₴ refunded to balance`,
    de: (name: string, refund: number) => `Tarif ${name} aktiviert. ${Math.round(refund)} ₴ auf Guthaben erstattet`,
  },
  documentsDeleted: {
    uk: (count: number) => `${count} документів видалено`,
    es: (count: number) => `${count} documentos eliminados`,
    en: (count: number) => `${count} documents deleted`,
    de: (count: number) => `${count} Dokumente gelöscht`,
  },
  uploadStarted: {
    uk: (count: number) => `Завантаження ${count} файлів розпочато`,
    es: (count: number) => `Carga de ${count} archivos iniciada`,
    en: (count: number) => `Upload of ${count} files started`,
    de: (count: number) => `Upload von ${count} Dateien gestartet`,
  },
  matterCreated: {
    uk: (name: string, count: number) => `Створено справу "${name}" (${count} документів)`,
    es: (name: string, count: number) => `Expediente "${name}" creado (${count} documentos)`,
    en: (name: string, count: number) => `Matter "${name}" created (${count} documents)`,
    de: (name: string, count: number) => `Akte "${name}" erstellt (${count} Dokumente)`,
  },
  documentsAssigned: {
    uk: (count: number, name: string) => `Додано ${count} документів до "${name}"`,
    es: (count: number, name: string) => `${count} documentos añadidos a "${name}"`,
    en: (count: number, name: string) => `${count} documents assigned to "${name}"`,
    de: (count: number, name: string) => `${count} Dokumente zu "${name}" hinzugefügt`,
  },
  documentsMovedToFolder: {
    uk: (folder: string) => `Документи переміщено в папку "${folder}"`,
    es: (folder: string) => `Documentos movidos a la carpeta "${folder}"`,
    en: (folder: string) => `Documents moved to folder "${folder}"`,
    de: (folder: string) => `Dokumente in Ordner "${folder}" verschoben`,
  },
  folderWillBeCreated: {
    uk: (name: string) => `Папку «${name}» буде створено при переміщенні`,
    es: (name: string) => `La carpeta «${name}» se creará al mover`,
    en: (name: string) => `Folder "${name}" will be created on move`,
    de: (name: string) => `Ordner „${name}" wird beim Verschieben erstellt`,
  },
  classificationCompleted: {
    uk: (completed: number, total: number) => `Класифікацію завершено: ${completed} з ${total} документів`,
    es: (completed: number, total: number) => `Clasificación completada: ${completed} de ${total} documentos`,
    en: (completed: number, total: number) => `Classification completed: ${completed} of ${total} documents`,
    de: (completed: number, total: number) => `Klassifizierung abgeschlossen: ${completed} von ${total} Dokumenten`,
  },
  documentsMarkedProcessed: {
    uk: (count: number) => `${count} документів позначено як оброблені`,
    es: (count: number) => `${count} documentos marcados como procesados`,
    en: (count: number) => `${count} documents marked as processed`,
    de: (count: number) => `${count} Dokumente als verarbeitet markiert`,
  },
  encryptedDocuments: {
    uk: (count: number) => `Зашифровано ${count} документів`,
    es: (count: number) => `${count} documentos cifrados`,
    en: (count: number) => `${count} documents encrypted`,
    de: (count: number) => `${count} Dokumente verschlüsselt`,
  },
  encryptionFailed: {
    uk: (count: number) => `Не вдалося зашифрувати ${count} документів`,
    es: (count: number) => `No se pudieron cifrar ${count} documentos`,
    en: (count: number) => `Failed to encrypt ${count} documents`,
    de: (count: number) => `${count} Dokumente konnten nicht verschlüsselt werden`,
  },
  budgetEscalated: {
    uk: (min: string, max: string) => `Глибокий аналіз — орієнтовна вартість ${min}–${max}`,
    es: (min: string, max: string) => `Análisis profundo — costo estimado ${min}–${max}`,
    en: (min: string, max: string) => `Deep analysis — estimated cost ${min}–${max}`,
    de: (min: string, max: string) => `Tiefenanalyse — geschätzte Kosten ${min}–${max}`,
  },
} as const;

type DynamicMessages = typeof dynamicMessages;
export type DynamicToastKey = keyof DynamicMessages;

/**
 * Get a translated dynamic toast message for the current locale.
 * Pass arguments matching the function signature for the given key.
 */
export function toastTDynamic<K extends DynamicToastKey>(
  key: K,
  ...args: Parameters<DynamicMessages[K]['uk']>
): string {
  const locale = getLocale();
  const entry = dynamicMessages[key];
  const fn = (entry[locale] ?? entry.uk) as (...a: Parameters<DynamicMessages[K]['uk']>) => string;
  return fn(...args);
}
