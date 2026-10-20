(function (root) {
  'use strict';

  const REASONS = ['didnt_work', 'hard_to_use', 'missing_feature', 'slow', 'switched', 'temporary', 'other'];
  const OPTIONAL_COMMENT_REASONS = ['temporary'];
  const COMMENT_MIN_LENGTH = 15;

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
      prompts: {
        didnt_work: { label: 'What happened, and what did you expect?', placeholder: "e.g. my CSS was saved but the page didn't change" },
        hard_to_use: { label: 'What was confusing?', placeholder: "e.g. I couldn't find how to turn a style off" },
        missing_feature: { label: 'Which feature do you need?', placeholder: 'e.g. apply one style to several sites at once' },
        slow: { label: 'When did it feel slow, and on which site?', placeholder: 'e.g. news sites loaded slowly after I added a style' },
        switched: { label: 'Which extension, and what does it do better?', placeholder: 'e.g. Stylus, because it can install styles shared by others' },
        temporary: { label: 'Anything else? (optional)', placeholder: 'e.g. I only needed to fix one page' },
        other: { label: 'Tell us what happened', placeholder: 'A sentence or two is enough' }
      },
      siteLabel: 'Which site? (optional)',
      sitePlaceholder: 'e.g. youtube.com',
      commentTooShort: 'Please write at least {min} characters so the developer can act on it.',
      submit: 'Send feedback',
      sending: 'Sending…',
      missingReason: 'Please choose a reason first.',
      sendFailed: 'Sending failed. Check your connection and try again.',
      privacy: 'Anonymous: no email, no account, nothing about your browsing. Only your answers, the extension version, and your browser version and operating system are sent.',
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
      prompts: {
        didnt_work: { label: 'Que s’est-il passé, et qu’attendiez-vous ?', placeholder: 'ex. : mon CSS était enregistré mais la page n’a pas changé' },
        hard_to_use: { label: 'Qu’est-ce qui n’était pas clair ?', placeholder: 'ex. : je n’ai pas trouvé comment désactiver un style' },
        missing_feature: { label: 'De quelle fonctionnalité avez-vous besoin ?', placeholder: 'ex. : appliquer un même style à plusieurs sites' },
        slow: { label: 'Quand était-ce lent, et sur quel site ?', placeholder: 'ex. : les sites d’actualité chargeaient lentement après l’ajout d’un style' },
        switched: { label: 'Quelle extension, et que fait-elle de mieux ?', placeholder: 'ex. : Stylus, parce qu’on peut y installer des styles partagés' },
        temporary: { label: 'Autre chose à ajouter ? (facultatif)', placeholder: 'ex. : je voulais seulement corriger une page' },
        other: { label: 'Racontez-nous ce qui s’est passé', placeholder: 'Une phrase ou deux suffisent' }
      },
      siteLabel: 'Sur quel site ? (facultatif)',
      sitePlaceholder: 'ex. : youtube.com',
      commentTooShort: 'Écrivez au moins {min} caractères pour que le développeur puisse agir.',
      submit: 'Envoyer',
      sending: 'Envoi…',
      missingReason: 'Choisissez d’abord une raison.',
      sendFailed: 'L’envoi a échoué. Vérifiez votre connexion et réessayez.',
      privacy: 'Anonyme : ni email, ni compte, rien sur votre navigation. Nous recevons uniquement vos réponses, la version de l’extension, celle de votre navigateur et votre système d’exploitation.',
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
      prompts: {
        didnt_work: { label: '¿Qué pasó y qué esperabas?', placeholder: 'p. ej.: mi CSS se guardó, pero la página no cambió' },
        hard_to_use: { label: '¿Qué te resultó confuso?', placeholder: 'p. ej.: no encontré cómo desactivar un estilo' },
        missing_feature: { label: '¿Qué función necesitas?', placeholder: 'p. ej.: aplicar un mismo estilo a varios sitios' },
        slow: { label: '¿Cuándo iba lento y en qué sitio?', placeholder: 'p. ej.: los sitios de noticias cargaban lento después de añadir un estilo' },
        switched: { label: '¿Qué extensión y qué hace mejor?', placeholder: 'p. ej.: Stylus, porque permite instalar estilos compartidos' },
        temporary: { label: '¿Algo más? (opcional)', placeholder: 'p. ej.: solo quería arreglar una página' },
        other: { label: 'Cuéntanos qué pasó', placeholder: 'Con una o dos frases basta' }
      },
      siteLabel: '¿En qué sitio? (opcional)',
      sitePlaceholder: 'p. ej.: youtube.com',
      commentTooShort: 'Escribe al menos {min} caracteres para que el desarrollador pueda actuar.',
      submit: 'Enviar',
      sending: 'Enviando…',
      missingReason: 'Elige un motivo primero.',
      sendFailed: 'No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.',
      privacy: 'Anónimo: sin correo, sin cuenta y nada sobre tu navegación. Solo se envían tus respuestas, la versión de la extensión, la versión de tu navegador y tu sistema operativo.',
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
      prompts: {
        didnt_work: { label: 'O que aconteceu e o que você esperava?', placeholder: 'ex.: meu CSS foi salvo, mas a página não mudou' },
        hard_to_use: { label: 'O que ficou confuso?', placeholder: 'ex.: não encontrei como desativar um estilo' },
        missing_feature: { label: 'De qual recurso você precisa?', placeholder: 'ex.: aplicar o mesmo estilo em vários sites' },
        slow: { label: 'Quando ficou lento e em qual site?', placeholder: 'ex.: sites de notícias demoravam a carregar depois que adicionei um estilo' },
        switched: { label: 'Qual extensão e o que ela faz melhor?', placeholder: 'ex.: Stylus, porque permite instalar estilos compartilhados' },
        temporary: { label: 'Algo mais? (opcional)', placeholder: 'ex.: só precisava corrigir uma página' },
        other: { label: 'Conte o que aconteceu', placeholder: 'Uma ou duas frases bastam' }
      },
      siteLabel: 'Em qual site? (opcional)',
      sitePlaceholder: 'ex.: youtube.com',
      commentTooShort: 'Escreva pelo menos {min} caracteres para que o desenvolvedor possa agir.',
      submit: 'Enviar',
      sending: 'Enviando…',
      missingReason: 'Escolha um motivo primeiro.',
      sendFailed: 'Não foi possível enviar. Verifique sua conexão e tente novamente.',
      privacy: 'Anônimo: sem e-mail, sem conta e nada sobre sua navegação. Só são enviados suas respostas, a versão da extensão, a versão do navegador e o sistema operacional.',
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
      prompts: {
        didnt_work: { label: 'Was ist passiert, und was haben Sie erwartet?', placeholder: 'z. B. mein CSS wurde gespeichert, aber die Seite hat sich nicht geändert' },
        hard_to_use: { label: 'Was war unklar?', placeholder: 'z. B. ich habe nicht gefunden, wie man einen Stil ausschaltet' },
        missing_feature: { label: 'Welche Funktion brauchen Sie?', placeholder: 'z. B. einen Stil auf mehrere Websites gleichzeitig anwenden' },
        slow: { label: 'Wann war es langsam, und auf welcher Website?', placeholder: 'z. B. Nachrichtenseiten luden langsam, nachdem ich einen Stil hinzugefügt hatte' },
        switched: { label: 'Welche Erweiterung, und was macht sie besser?', placeholder: 'z. B. Stylus, weil man dort geteilte Stile installieren kann' },
        temporary: { label: 'Noch etwas? (optional)', placeholder: 'z. B. ich wollte nur eine Seite anpassen' },
        other: { label: 'Erzählen Sie uns, was passiert ist', placeholder: 'Ein oder zwei Sätze genügen' }
      },
      siteLabel: 'Welche Website? (optional)',
      sitePlaceholder: 'z. B. youtube.com',
      commentTooShort: 'Bitte schreiben Sie mindestens {min} Zeichen, damit der Entwickler etwas damit anfangen kann.',
      submit: 'Absenden',
      sending: 'Wird gesendet…',
      missingReason: 'Bitte wählen Sie zuerst einen Grund.',
      sendFailed: 'Senden fehlgeschlagen. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
      privacy: 'Anonym: keine E-Mail, kein Konto, nichts über Ihr Surfverhalten. Gesendet werden nur Ihre Antworten, die Version der Erweiterung, Ihre Browserversion und Ihr Betriebssystem.',
      thanksTitle: 'Vielen Dank!',
      thanksBody: 'Ihre Antwort wurde gesendet. Sie geht direkt an den Entwickler und hilft zu entscheiden, was als Nächstes verbessert wird.',
      reinstall: 'Meinung geändert? Custom CSS Injector erneut installieren'
    }
  };

  function isCommentRequired(reason) {
    return REASONS.includes(reason) && !OPTIONAL_COMMENT_REASONS.includes(reason);
  }

  function isCommentValid(reason, comment) {
    return !isCommentRequired(reason) || String(comment || '').trim().length >= COMMENT_MIN_LENGTH;
  }

  // Only a hostname leaves the page: never a path, query, fragment, port, or credentials.
  const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

  function extractHostname(input) {
    const text = String(input || '').trim();
    if (!text || /\s/.test(text)) return '';
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    let hostname;
    try {
      hostname = new URL(candidate).hostname.replace(/\.$/, '');
    } catch {
      return '';
    }
    return HOSTNAME_PATTERN.test(hostname) ? hostname : '';
  }

  const BRANDS = [
    ['Google Chrome', 'Chrome'],
    ['Microsoft Edge', 'Edge'],
    ['Opera', 'Opera'],
    ['Brave', 'Brave'],
    ['Chromium', 'Chromium']
  ];

  const USER_AGENT_BROWSERS = [
    [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
    [/(?:Chrome|CriOS)\/(\d+)/, 'Chrome'],
    [/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, 'Safari']
  ];

  const PLATFORMS = {
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
    'chrome os': 'ChromeOS',
    chromeos: 'ChromeOS'
  };

  function detectBrowser(nav) {
    const brands = nav.userAgentData && nav.userAgentData.brands;
    if (Array.isArray(brands)) {
      for (const [brand, name] of BRANDS) {
        const match = brands.find((entry) => entry && entry.brand === brand);
        const major = match && /^\d+/.exec(String(match.version));
        if (major) return `${name} ${major[0]}`;
      }
    }
    const userAgent = String(nav.userAgent || '');
    for (const [pattern, name] of USER_AGENT_BROWSERS) {
      const match = pattern.exec(userAgent);
      if (match) return `${name} ${match[1]}`;
    }
    return 'unknown';
  }

  function detectOs(nav) {
    const platform = nav.userAgentData && nav.userAgentData.platform;
    if (typeof platform === 'string' && platform) return PLATFORMS[platform.toLowerCase()] || 'other';
    const userAgent = String(nav.userAgent || '');
    if (/CrOS/.test(userAgent)) return 'ChromeOS';
    if (/Android|iPhone|iPad|iPod/.test(userAgent)) return 'other';
    if (/Windows/.test(userAgent)) return 'Windows';
    if (/Macintosh|Mac OS X/.test(userAgent)) return 'macOS';
    if (/Linux|X11/.test(userAgent)) return 'Linux';
    return 'other';
  }

  // Coarse on purpose: a browser name with its major version and an OS family, never the full user agent.
  function detectEnvironment(nav) {
    const source = nav || {};
    return { browser: detectBrowser(source), os: detectOs(source) };
  }

  const api = {
    REASONS,
    COMMENT_MIN_LENGTH,
    MESSAGES,
    isCommentRequired,
    isCommentValid,
    extractHostname,
    detectEnvironment
  };

  root.UninstallFeedback = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(globalThis);
