import { test, expect, Page } from '@playwright/test';

test.use({ locale: 'en-US' });

const CUSTOMER_EMAIL = 'customer@practicesoftwaretesting.com';
const CUSTOMER_PASSWORD = 'welcome01';
const PRODUCTO = 'Combination Pliers';
const PRECIO = 14.15;
const TOTAL_CARRITO = `$${PRECIO.toFixed(2)}`;
const MENSAJE_EXPIRACION_PASADA = 'Expiration date must be in the future.';
const MENSAJE_GIFT_NUMBER =
  'Please enter a valid gift card number: exactly 16 letters and/or digits.';
const MENSAJE_GIFT_CODE =
  'Please enter a valid validation code: exactly 4 letters and/or digits.';

const DIRECCION = {
  country: 'CO',
  postal_code: '760001',
  house_number: '10',
  street: 'Calle 5 #10-20',
  city: 'Cali',
  state: 'Valle',
};

const TARJETA = {
  number: '4111-1111-1111-1111',
  expiration: '12/2030',
  cvv: '123',
  holder: 'Iker Mainguez',
};

/** BVA: MM/YYYY del mes calendario anterior al actual (límite inferior inválido). */
function expiracionMesAnterior(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${mm}/${d.getFullYear()}`;
}

async function iniciarSesion(page: Page) {
  await page.goto('/auth/login');
  await page.getByTestId('email').fill(CUSTOMER_EMAIL);
  await page.getByTestId('password').fill(CUSTOMER_PASSWORD);
  const respuesta = page.waitForResponse(
    (r) => r.url().endsWith('/users/login') && r.request().method() === 'POST',
  );
  await page.getByTestId('login-submit').click();
  expect((await respuesta).status()).toBe(200);
  await expect(page).toHaveURL(/\/account$/);
}

async function agregarProductoAlCarrito(page: Page) {
  await page.goto('/');
  await page.getByTestId('product-name').first().waitFor();
  await page.getByTestId('product-name').filter({ hasText: PRODUCTO }).click();
  await expect(page.getByTestId('product-name')).toHaveText(PRODUCTO);

  const respuesta = page.waitForResponse(
    (r) => r.url().includes('/carts/') && r.request().method() === 'POST',
  );
  await page.getByTestId('add-to-cart').click();
  expect((await respuesta).ok()).toBeTruthy();
  await expect(page.getByTestId('cart-quantity')).toHaveText('1');
}

async function completarDireccion(page: Page) {
  await page.getByTestId('country').selectOption(DIRECCION.country);
  await page.getByTestId('postal_code').fill(DIRECCION.postal_code);
  await page.getByTestId('house_number').fill(DIRECCION.house_number);

  await expect(page.getByTestId('postcode-lookup-loading')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('postcode-lookup-error')).toHaveCount(0);
  await expect(page.getByTestId('street')).not.toBeEmpty();
  await expect(page.getByTestId('city')).not.toBeEmpty();

  await expect(page.getByTestId('proceed-3')).toBeEnabled();
  await page.getByTestId('proceed-3').click();
}

/** Sesión + 1 producto → paso Billing Address (sin completar dirección). */
async function irAlPasoDeDireccion(page: Page) {
  await iniciarSesion(page);
  await agregarProductoAlCarrito(page);

  await page.getByTestId('nav-cart').click();
  await expect(page.getByTestId('product-title')).toContainText(PRODUCTO);
  await expect(page.getByTestId('cart-total')).toHaveText(TOTAL_CARRITO);
  await page.getByTestId('proceed-1').click();

  await expect(page.getByTestId('proceed-2')).toBeVisible();
  await page.getByTestId('proceed-2').click();

  await expect(page.getByRole('heading', { name: 'Billing Address' })).toBeVisible();
  await expect(page.getByTestId('postal_code')).toBeVisible();
}

/** Precondiciones de pago: sesión + 1 producto + dirección → paso Payment. */
async function irAlPasoDePago(page: Page) {
  await irAlPasoDeDireccion(page);
  await completarDireccion(page);
  await expect(page.getByTestId('payment-method')).toBeVisible();
}

test('TC-CHK-001 Compra E2E con tarjeta de crédito', async ({ page }) => {
  await irAlPasoDePago(page);

  await page.getByTestId('payment-method').selectOption('credit-card');
  await page.getByTestId('credit_card_number').fill(TARJETA.number);
  await page.getByTestId('expiration_date').fill(TARJETA.expiration);
  await page.getByTestId('cvv').fill(TARJETA.cvv);
  await page.getByTestId('card_holder_name').fill(TARJETA.holder);

  const pago = page.waitForResponse(
    (r) => r.url().includes('/payment/check') && r.request().method() === 'POST',
  );
  await page.getByTestId('finish').click();
  const respPago = await pago;
  expect(respPago.status()).toBe(200);
  expect((await respPago.json()).message).toBe('Payment was successful');
  await expect(page.getByTestId('payment-success-message')).toHaveText('Payment was successful');
  await page.screenshot({ path: 'evidence/TC-CHK-001-pago-exitoso.png', fullPage: true });

  const factura = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/invoices' && r.request().method() === 'POST',
  );
  const carritoBorrado = page.waitForResponse(
    (r) => /\/carts\/[^/?]+$/.test(new URL(r.url()).pathname) && r.request().method() === 'DELETE',
  );
  await page.getByTestId('finish').click();
  const respFactura = await factura;
  expect(respFactura.status()).toBe(201);
  const body = await respFactura.json();
  const invoiceNumber = body.invoice_number as string;
  expect(invoiceNumber).toMatch(/^INV-/);

  await expect(page.locator('#order-confirmation')).toBeVisible();
  await expect(page.locator('#order-confirmation')).toContainText(invoiceNumber);

  await carritoBorrado;
  await expect(page.getByTestId('cart-quantity')).toHaveCount(0);

  const totalFactura = `$${Number(body.total).toFixed(2)}`;
  await page.getByTestId('nav-menu').click();
  await page.getByTestId('nav-my-invoices').click();
  await expect(page.getByTestId('page-title')).toHaveText('Invoices');
  const fila = page.locator('table tbody tr').filter({ hasText: invoiceNumber });
  await expect(fila).toBeVisible();
  await expect(fila.locator('td').nth(3)).toHaveText(totalFactura);
  expect(totalFactura).toBe(TOTAL_CARRITO);
});

test('TC-CHK-002 Tarjeta con fecha de expiración vencida', async ({ page }) => {
  const expiracion = expiracionMesAnterior(); // p.ej. 10/2026 si hoy es nov-2026 (BVA)

  await irAlPasoDePago(page);

  await page.getByTestId('payment-method').selectOption('credit-card');
  await page.getByTestId('credit_card_number').fill(TARJETA.number);
  await page.getByTestId('expiration_date').fill(expiracion);
  await page.getByTestId('expiration_date').blur();
  await page.getByTestId('cvv').fill(TARJETA.cvv);
  await page.getByTestId('card_holder_name').fill(TARJETA.holder);

  // Esperado 1: mensaje de expiración inválida (en.json date-error-past)
  await expect(page.locator('.alert-danger')).toContainText(MENSAJE_EXPIRACION_PASADA);
  await page.screenshot({ path: 'evidence/TC-CHK-002-expiracion-vencida.png', fullPage: true });

  // Esperado 2: Confirm deshabilitado (cusPayment.valid === false)
  await expect(page.getByTestId('finish')).toBeDisabled();

  // Esperado 3: no se envía petición de pago ni de factura
  const huboPago = page
    .waitForRequest(
      (req) => {
        const path = new URL(req.url()).pathname;
        return path.includes('/payment/check') || (path === '/invoices' && req.method() === 'POST');
      },
      { timeout: 1500 },
    )
    .then(() => true)
    .catch(() => false);
  await page.getByTestId('finish').click({ force: true });
  expect(await huboPago).toBe(false);

  // Postcondiciones: sigue en pago; carrito conserva el producto
  await expect(page.getByTestId('payment-method')).toBeVisible();
  await expect(page.getByTestId('cart-quantity')).toHaveText('1');
});

test('TC-CHK-003 Dirección de facturación con código postal vacío', async ({ page }) => {
  await irAlPasoDeDireccion(page);

  // Datos del caso (+ house_number †: obligatorio en address.component.ts, no está en el caso)
  await page.getByTestId('country').selectOption(DIRECCION.country);
  await page.getByTestId('street').fill(DIRECCION.street);
  await page.getByTestId('city').fill(DIRECCION.city);
  await page.getByTestId('state').fill(DIRECCION.state);
  await page.getByTestId('house_number').fill(DIRECCION.house_number);
  await page.getByTestId('postal_code').fill('');
  await page.getByTestId('postal_code').click();
  await page.getByTestId('postal_code').blur();

  // Esperado 1 (diseño): "Postcode is required" — † no se renderiza en checkout/address
  // (sí en register + en.json). El bloqueo observable es el botón deshabilitado.
  await page.screenshot({ path: 'evidence/TC-CHK-003-postal-vacio.png', fullPage: true });

  // Esperado 2: Proceed to checkout deshabilitado (cusAddress.valid === false)
  await expect(page.getByTestId('proceed-3')).toBeDisabled();

  // Esperado 3: el wizard mantiene Payment en el DOM, pero no está visible/activo
  await expect(page.getByTestId('payment-method')).toBeHidden();

  // Postcondiciones: permanece en dirección; carrito intacto
  await expect(page.getByRole('heading', { name: 'Billing Address' })).toBeVisible();
  await expect(page.getByTestId('cart-quantity')).toHaveText('1');
});

test('TC-CHK-004 Gift card con código inválido', async ({ page }) => {
  await irAlPasoDePago(page);

  await page.getByTestId('payment-method').selectOption('gift-card');
  // Datos del caso: no cumplen ^[a-zA-Z0-9]{16}$ / ^[a-zA-Z0-9]{4}$ (UI + GiftCard.php)
  await page.getByTestId('gift_card_number').fill('0000-INVALID');
  await page.getByTestId('gift_card_number').blur();
  await page.getByTestId('validation_code').fill('000');
  await page.getByTestId('validation_code').blur();

  // Esperado 1: errores de formato en UI (en.json gift-card.*)
  await expect(page.getByText(MENSAJE_GIFT_NUMBER)).toBeVisible();
  await expect(page.getByText(MENSAJE_GIFT_CODE)).toBeVisible();
  await page.screenshot({ path: 'evidence/TC-CHK-004-gift-card-invalida.png', fullPage: true });

  // Confirm deshabilitado → no llega a API; no hay "Payment was successful" ni factura
  await expect(page.getByTestId('finish')).toBeDisabled();
  await expect(page.getByTestId('payment-success-message')).toHaveCount(0);
  await expect(page.locator('#order-confirmation')).toHaveCount(0);

  const huboPago = page
    .waitForRequest(
      (req) => {
        const path = new URL(req.url()).pathname;
        return path.includes('/payment/check') || (path === '/invoices' && req.method() === 'POST');
      },
      { timeout: 1500 },
    )
    .then(() => true)
    .catch(() => false);
  await page.getByTestId('finish').click({ force: true });
  expect(await huboPago).toBe(false);

  // Postcondiciones: sigue en pago; puede cambiar de método; carrito intacto
  await expect(page.getByTestId('payment-method')).toBeVisible();
  await expect(page.getByTestId('payment-method')).toBeEnabled();
  await expect(page.getByTestId('cart-quantity')).toHaveText('1');
});
