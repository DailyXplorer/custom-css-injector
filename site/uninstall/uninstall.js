'use strict';

// Web3Forms access keys are public by design: they only allow sending to the owner's inbox.
const WEB3FORMS_ACCESS_KEY = 'e89d5081-afd5-4b06-82b5-6cc91ce426a0';
const WEB3FORMS_ENDPOINT = 'https://api.web3forms.com/submit';

const MESSAGES = {
  en: {
    title: 'Sorry to see you go',
    lead: 'Custom CSS Injector has been removed. Tell us why in ten seconds and help make it better for everyone.',
    reasonLegend: 'Why did you uninstall it?',
    reasonDidntWork: "It didn't work on a site I use",
    reasonHardToUse: 'It was hard to use',
    reasonMissingFeature: 'A feature I need is missing',
    reasonSlow: 'It slowed down my browser',
    reasonSwitched: 'I switched to another extension',
    reasonTemporary: 'I only needed it for a short time',
    reasonOther: 'Another reason',
    commentLabel: 'Anything else? (optional)',
    commentPlaceholder: 'Which site, which feature, or which extension replaced it?',
    submit: 'Send feedback',
    sending: 'Sending…',
    missingReason: 'Please choose a reason first.',
    sendFailed: 'Sending failed. Check your connection and try again.',
    privacy: 'Anonymous: no email, no account, nothing about your browsing. Only your answers and the extension version are sent.',
    thanksTitle: 'Thank you!',
    thanksBody: 'Your answer has been sent. It goes straight to the developer and helps decide what to fix next.',
    reinstall: 'Changed your mind? Reinstall Custom CSS Injector'
  },
  fr: {
    title: 'Dommage de vous voir partir',
    lead: 'Custom CSS Injector a été désinstallé. Dites-nous pourquoi en dix secondes pour aider à l’améliorer.',
    reasonLegend: 'Pourquoi l’avez-vous désinstallé ?',
    reasonDidntWork: 'Il ne fonctionnait pas sur un site que j’utilise',
    reasonHardToUse: 'Il était difficile à utiliser',
    reasonMissingFeature: 'Il manque une fonctionnalité dont j’ai besoin',
    reasonSlow: 'Il ralentissait mon navigateur',
    reasonSwitched: 'J’utilise une autre extension',
    reasonTemporary: 'Je n’en avais besoin que ponctuellement',
    reasonOther: 'Une autre raison',
    commentLabel: 'Autre chose à ajouter ? (facultatif)',
    commentPlaceholder: 'Quel site, quelle fonctionnalité, ou quelle extension l’a remplacé ?',
    submit: 'Envoyer',
    sending: 'Envoi…',
    missingReason: 'Choisissez d’abord une raison.',
    sendFailed: 'L’envoi a échoué. Vérifiez votre connexion et réessayez.',
    privacy: 'Anonyme : ni email, ni compte, rien sur votre navigation. Seules vos réponses et la version de l’extension sont envoyées.',
    thanksTitle: 'Merci !',
    thanksBody: 'Votre réponse a bien été envoyée. Elle arrive directement au développeur et l’aide à choisir quoi corriger en priorité.',
    reinstall: 'Vous avez changé d’avis ? Réinstaller Custom CSS Injector'
  },
  es: {
    title: 'Lamentamos que te vayas',
    lead: 'Custom CSS Injector se ha desinstalado. Cuéntanos por qué en diez segundos y ayúdanos a mejorarlo.',
    reasonLegend: '¿Por qué lo desinstalaste?',
    reasonDidntWork: 'No funcionaba en un sitio que uso',
    reasonHardToUse: 'Era difícil de usar',
    reasonMissingFeature: 'Falta una función que necesito',
    reasonSlow: 'Hacía más lento mi navegador',
    reasonSwitched: 'Me cambié a otra extensión',
    reasonTemporary: 'Solo lo necesitaba por poco tiempo',
    reasonOther: 'Otro motivo',
    commentLabel: '¿Algo más? (opcional)',
    commentPlaceholder: '¿Qué sitio, qué función o qué extensión lo reemplazó?',
    submit: 'Enviar',
    sending: 'Enviando…',
    missingReason: 'Elige un motivo primero.',
    sendFailed: 'No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.',
    privacy: 'Anónimo: sin correo, sin cuenta y nada sobre tu navegación. Solo se envían tus respuestas y la versión de la extensión.',
    thanksTitle: '¡Gracias!',
    thanksBody: 'Tu respuesta se ha enviado. Llega directamente al desarrollador y le ayuda a decidir qué corregir primero.',
    reinstall: '¿Cambiaste de opinión? Reinstalar Custom CSS Injector'
  },
  pt: {
    title: 'Que pena ver você partir',
    lead: 'O Custom CSS Injector foi desinstalado. Conte em dez segundos o motivo e ajude a melhorá-lo.',
    reasonLegend: 'Por que você o desinstalou?',
    reasonDidntWork: 'Não funcionou em um site que eu uso',
    reasonHardToUse: 'Era difícil de usar',
    reasonMissingFeature: 'Falta um recurso de que preciso',
    reasonSlow: 'Deixava meu navegador lento',
    reasonSwitched: 'Troquei por outra extensão',
    reasonTemporary: 'Só precisei dele por pouco tempo',
    reasonOther: 'Outro motivo',
    commentLabel: 'Algo mais? (opcional)',
    commentPlaceholder: 'Qual site, qual recurso ou qual extensão o substituiu?',
    submit: 'Enviar',
    sending: 'Enviando…',
    missingReason: 'Escolha um motivo primeiro.',
    sendFailed: 'Não foi possível enviar. Verifique sua conexão e tente novamente.',
    privacy: 'Anônimo: sem e-mail, sem conta e nada sobre sua navegação. Só suas respostas e a versão da extensão são enviadas.',
    thanksTitle: 'Obrigado!',
    thanksBody: 'Sua resposta foi enviada. Ela vai direto para o desenvolvedor e ajuda a decidir o que corrigir primeiro.',
    reinstall: 'Mudou de ideia? Reinstalar o Custom CSS Injector'
  },
  de: {
    title: 'Schade, dass Sie gehen',
    lead: 'Custom CSS Injector wurde entfernt. Sagen Sie uns in zehn Sekunden, warum, und helfen Sie, es zu verbessern.',
    reasonLegend: 'Warum haben Sie es deinstalliert?',
    reasonDidntWork: 'Es hat auf einer Website, die ich nutze, nicht funktioniert',
    reasonHardToUse: 'Es war schwer zu bedienen',
    reasonMissingFeature: 'Eine Funktion, die ich brauche, fehlt',
    reasonSlow: 'Es hat meinen Browser verlangsamt',
    reasonSwitched: 'Ich nutze jetzt eine andere Erweiterung',
    reasonTemporary: 'Ich habe es nur kurz gebraucht',
    reasonOther: 'Ein anderer Grund',
    commentLabel: 'Noch etwas? (optional)',
    commentPlaceholder: 'Welche Website, welche Funktion oder welche Erweiterung hat es ersetzt?',
    submit: 'Absenden',
    sending: 'Wird gesendet…',
    missingReason: 'Bitte wählen Sie zuerst einen Grund.',
    sendFailed: 'Senden fehlgeschlagen. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
    privacy: 'Anonym: keine E-Mail, kein Konto, nichts über Ihr Surfverhalten. Gesendet werden nur Ihre Antworten und die Version der Erweiterung.',
    thanksTitle: 'Vielen Dank!',
    thanksBody: 'Ihre Antwort wurde gesendet. Sie geht direkt an den Entwickler und hilft zu entscheiden, was als Nächstes verbessert wird.',
    reinstall: 'Meinung geändert? Custom CSS Injector erneut installieren'
  }
};

function pickLanguage() {
  const requested = new URLSearchParams(location.search).get('lang');
  const candidates = [requested, ...(navigator.languages || [navigator.language])];
  for (const candidate of candidates) {
    const base = String(candidate || '').toLowerCase().split(/[-_]/)[0];
    if (MESSAGES[base]) return base;
  }
  return 'en';
}

const language = pickLanguage();
const messages = MESSAGES[language];

function applyTranslations() {
  document.documentElement.lang = language;
  document.title = `Custom CSS Injector — ${messages.title}`;
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = messages[element.dataset.i18n];
  }
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
    element.placeholder = messages[element.dataset.i18nPlaceholder];
  }
}

function setStatus(text, state) {
  const status = document.getElementById('feedback-status');
  status.textContent = text;
  status.dataset.state = state;
}

async function submitFeedback(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const reason = form.elements.reason.value;
  if (!reason) {
    setStatus(messages.missingReason, 'error');
    return;
  }

  const button = form.querySelector('.feedback-submit');
  button.disabled = true;
  setStatus(messages.sending, 'pending');

  const payload = {
    access_key: WEB3FORMS_ACCESS_KEY,
    subject: `Uninstall feedback: ${reason}`,
    from_name: 'Custom CSS Injector',
    reason,
    comment: form.elements.comment.value.trim(),
    version: new URLSearchParams(location.search).get('v') || 'unknown',
    language,
    botcheck: form.elements.botcheck.checked
  };

  try {
    const response = await fetch(WEB3FORMS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.message || `HTTP ${response.status}`);

    form.hidden = true;
    document.getElementById('feedback-thanks').hidden = false;
  } catch (error) {
    console.warn('Uninstall feedback failed:', error);
    button.disabled = false;
    setStatus(messages.sendFailed, 'error');
  }
}

applyTranslations();
document.getElementById('feedback-form').addEventListener('submit', submitFeedback);
