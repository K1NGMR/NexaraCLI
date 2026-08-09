import qrcode from "qrcode-terminal";

export function printQr(value) {
  qrcode.generate(value, { small: true });
}
