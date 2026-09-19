import asyncio
from html import escape
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from domain.auth.entities.user import User
from shared.settings import AppSettings


class SmtpRegistrationEmailSender:
    def __init__(self, settings: AppSettings):
        self._settings = settings

    async def send_registration_email(self, user: User, confirmation_url: str) -> None:
        if not self._settings.smtp_enabled:
            return
        await asyncio.to_thread(self._send_registration_email, user, confirmation_url)

    async def send_password_reset_email(self, user: User, reset_url: str) -> None:
        if not self._settings.smtp_enabled:
            return
        await asyncio.to_thread(self._send_password_reset_email, user, reset_url)

    def _send_registration_email(self, user: User, confirmation_url: str) -> None:
        message = EmailMessage()
        message["Subject"] = self._settings.registration_email_subject
        message["From"] = formataddr((self._settings.smtp_from_name, self._settings.smtp_from_email))
        message["To"] = user.email
        message["Message-ID"] = make_msgid(domain="pumpling.xyz")

        text_body = (
            "Hi,\n\n"
            "Your Pumpling account has been created. Confirm your email to activate it.\n\n"
            f"Confirm email: {confirmation_url}\n\n"
            "This link expires in 24 hours.\n\n"
            f"Email: {user.email}\n\n"
            "If this was not you, ignore this email.\n"
        )
        escaped_email = escape(user.email)
        escaped_confirmation_url = escape(confirmation_url, quote=True)
        html_body = (
            "<!doctype html>"
            "<html><body>"
            "<p>Hi,</p>"
            "<p>Your Pumpling account has been created. Confirm your email to activate it.</p>"
            f'<p><a href="{escaped_confirmation_url}">Confirm email</a></p>'
            "<p>This link expires in 24 hours.</p>"
            f"<p><strong>Email:</strong> {escaped_email}</p>"
            "<p>If this was not you, ignore this email.</p>"
            "</body></html>"
        )
        message.set_content(text_body)
        message.add_alternative(html_body, subtype="html")
        self._send_email_message(message)

    def _send_password_reset_email(self, user: User, reset_url: str) -> None:
        message = EmailMessage()
        message["Subject"] = self._settings.password_reset_email_subject
        message["From"] = formataddr((self._settings.smtp_from_name, self._settings.smtp_from_email))
        message["To"] = user.email
        message["Message-ID"] = make_msgid(domain="pumpling.xyz")

        text_body = (
            "Hi,\n\n"
            "Use this link to set a new Pumpling password:\n\n"
            f"{reset_url}\n\n"
            "This link expires in 24 hours.\n\n"
            "If this was not you, ignore this email.\n"
        )
        escaped_reset_url = escape(reset_url, quote=True)
        html_body = (
            "<!doctype html>"
            "<html><body>"
            "<p>Hi,</p>"
            "<p>Use this link to set a new Pumpling password:</p>"
            f'<p><a href="{escaped_reset_url}">Reset password</a></p>'
            "<p>This link expires in 24 hours.</p>"
            "<p>If this was not you, ignore this email.</p>"
            "</body></html>"
        )
        message.set_content(text_body)
        message.add_alternative(html_body, subtype="html")
        self._send_email_message(message)

    def _send_email_message(self, message: EmailMessage) -> None:
        if self._settings.smtp_use_ssl:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(
                self._settings.smtp_host,
                self._settings.smtp_port,
                timeout=self._settings.smtp_timeout_seconds,
                context=context,
            ) as smtp:
                self._send_message(smtp, message)
            return

        with smtplib.SMTP(
            self._settings.smtp_host,
            self._settings.smtp_port,
            timeout=self._settings.smtp_timeout_seconds,
        ) as smtp:
            if self._settings.smtp_use_tls:
                smtp.starttls(context=ssl.create_default_context())
            self._send_message(smtp, message)

    def _send_message(self, smtp: smtplib.SMTP, message: EmailMessage) -> None:
        if self._settings.smtp_username:
            smtp.login(self._settings.smtp_username, self._settings.smtp_password)
        smtp.send_message(message)
