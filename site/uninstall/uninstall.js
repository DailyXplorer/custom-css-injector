'use strict';

// Web3Forms access keys are public by design: they only allow sending to the owner's inbox.
const WEB3FORMS_ACCESS_KEY = 'e89d5081-afd5-4b06-82b5-6cc91ce426a0';
const WEB3FORMS_ENDPOINT = 'https://api.web3forms.com/submit';

const {
  MESSAGES,
  COMMENT_MIN_LENGTH,
  isCommentRequired,
  isCommentValid,
  extractHostname,
  detectEnvironment
} = globalThis.UninstallFeedback;

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
  document.title = `${messages.title} | Custom CSS Injector`;
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

function setCommentError(visible) {
  const comment = document.getElementById('feedback-comment');
  const error = document.getElementById('feedback-comment-error');
  error.textContent = visible ? messages.commentTooShort.replace('{min}', COMMENT_MIN_LENGTH) : '';
  error.hidden = !visible;
  if (visible) {
    comment.setAttribute('aria-invalid', 'true');
  } else {
    comment.removeAttribute('aria-invalid');
  }
}

function applyReason(form) {
  const reason = form.elements.reason.value;
  const prompt = messages.prompts[reason];
  document.getElementById('feedback-details').hidden = !prompt;
  document.getElementById('feedback-site-field').hidden = reason !== 'didnt_work';
  if (!prompt) return;

  const comment = form.elements.comment;
  document.getElementById('feedback-comment-label').textContent = prompt.label;
  comment.placeholder = prompt.placeholder;
  comment.required = isCommentRequired(reason);
  if (comment.required) {
    comment.minLength = COMMENT_MIN_LENGTH;
  } else {
    comment.removeAttribute('minlength');
  }
  if (isCommentValid(reason, comment.value)) setCommentError(false);
}

function handleCommentInput(event) {
  const form = event.currentTarget.form;
  if (isCommentValid(form.elements.reason.value, event.currentTarget.value)) setCommentError(false);
}

async function submitFeedback(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const reason = form.elements.reason.value;
  if (!reason) {
    setStatus(messages.missingReason, 'error');
    return;
  }
  if (!isCommentValid(reason, form.elements.comment.value)) {
    setStatus('', '');
    setCommentError(true);
    form.elements.comment.focus();
    return;
  }

  const button = form.querySelector('.feedback-submit');
  button.disabled = true;
  setStatus(messages.sending, 'pending');

  const { browser, os } = detectEnvironment(navigator);
  const payload = {
    access_key: WEB3FORMS_ACCESS_KEY,
    subject: `Uninstall feedback: ${reason}`,
    from_name: 'Custom CSS Injector',
    reason,
    comment: form.elements.comment.value.trim(),
    ...(reason === 'didnt_work' ? { site: extractHostname(form.elements.site.value) } : {}),
    version: new URLSearchParams(location.search).get('v') || 'unknown',
    language,
    browser,
    os,
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

const feedbackForm = document.getElementById('feedback-form');
applyTranslations();
applyReason(feedbackForm);
feedbackForm.addEventListener('change', () => applyReason(feedbackForm));
feedbackForm.addEventListener('submit', submitFeedback);
document.getElementById('feedback-comment').addEventListener('input', handleCommentInput);
