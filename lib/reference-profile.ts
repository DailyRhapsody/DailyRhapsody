/** 公司档案字段；与 Notion Reference DB 的扩展属性一一对应。 */
export type ReferenceCompanyProfile = {
  companyName: string;
  headcount: number | null;
  operationCulture: string;
  productForms: string[];
  markets: string[];
  scenarios: string[];
  companyTags: string[];
  interviewStatus: string;
  salesModes: string[];
  listed: string;
  profitability: string;
};
