/** 博客名后的注册商标标记；头图与首页共用同一套比例规则。 */
export function BrandName({
  name,
  className,
  markClassName = "text-[0.95em]",
}: {
  name: string;
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={`inline-flex items-start gap-1.5 ${className ?? ""}`}>
      <span>{name}</span>
      <sup
        aria-label="注册商标"
        className={`mt-[0.12em] font-medium leading-none tracking-normal text-white/70 ${markClassName}`}
      >
        ®
      </sup>
    </span>
  );
}
