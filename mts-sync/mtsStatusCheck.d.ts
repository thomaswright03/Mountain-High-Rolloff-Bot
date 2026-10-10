export function checkMtsLeadStatuses(page: any, phone: string): Promise<string[]>;
export function checkMtsContractList(
  page: any,
  phone: string
): Promise<Array<{ custNumber: string; name: string; medium: string; status: string; saleDate: string }>>;
