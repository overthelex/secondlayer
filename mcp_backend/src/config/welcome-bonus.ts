/**
 * Card link offer, also quoted on the public site. The customer pays
 * CARD_LINK_PAYMENT_UAH when linking a card; that payment is not refunded but
 * credited to the balance as an ordinary top-up, and WELCOME_BONUS_UAH is
 * added on top once per person (see WelcomeBonusService).
 */
export const CARD_LINK_PAYMENT_UAH = 200;
export const WELCOME_BONUS_UAH = 200;
export const CARD_LINK_TOTAL_UAH = CARD_LINK_PAYMENT_UAH + WELCOME_BONUS_UAH;
