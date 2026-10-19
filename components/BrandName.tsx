/** 博客名后的注册商标标记；头图与首页共用同一套比例规则。 */
export function BrandName({
  name,
  className,
  markClassName = "text-[0.45em]",
}: {
  name: string;
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={className}>
      {name}
      <sup
        aria-label="注册商标"
        className={`ml-[0.18em] align-super font-medium tracking-normal text-white/70 ${markClassName}`}
      >
        ®
      </sup>
    </span>
  );
}
