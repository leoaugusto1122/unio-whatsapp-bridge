declare module 'qrcode' {
  export type QRCodeErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H'

  export type QRCodeToDataURLOptions = {
    type?: string
    margin?: number
    scale?: number
    errorCorrectionLevel?: QRCodeErrorCorrectionLevel
  }

  export function toDataURL(
    text: string,
    options?: QRCodeToDataURLOptions
  ): Promise<string>

  const QRCode: {
    toDataURL: typeof toDataURL
  }

  export default QRCode
}

