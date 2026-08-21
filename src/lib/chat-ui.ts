export function isNearBottom({ scrollHeight, scrollTop, clientHeight }: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>, threshold = 32) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
