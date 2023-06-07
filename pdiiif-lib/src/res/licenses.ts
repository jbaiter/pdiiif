export interface LicenseDescription {
  text: string;
  logo: string;
}
export type LicenseList = Record<string, LicenseDescription>;

// TODO: Re-generate this list based on the official CC RDF files:
//  https://github.com/creativecommons/cc-licenses-data/blob/main/legacy/rdf-licenses
export const licenses: LicenseList = {
  'http://creativecommons.org/licenses/by-nc-sa/2.0/fr/': {
    text: 'Creative Commons Attribution-NonCommercial-ShareAlike 2.0 France (CC-BY-NC-SA-2.0-FR)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-sa.svg',
  },
  'http://creativecommons.org/licenses/by-sa/4.0/': {
    text: 'Creative Commons Attribution Share Alike 4.0 International (CC-BY-SA-4.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-sa.svg',
  },
  'http://creativecommons.org/licenses/by/3.0/de/': {
    text: 'Creative Commons Attribution 3.0 Germany (CC-BY-3.0-DE)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by.svg',
  },
  'http://creativecommons.org/licenses/by-nc-nd/3.0/': {
    text: 'Creative Commons Attribution Non Commercial No Derivatives 3.0 Unported (CC-BY-NC-ND-3.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-nd.svg',
  },
  'http://creativecommons.org/licenses/by/1.0/': {
    text: 'Creative Commons Attribution 1.0 Generic (CC-BY-1.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by.svg',
  },
  'http://creativecommons.org/licenses/by-nd/1.0/': {
    text: 'Creative Commons Attribution No Derivatives 1.0 Generic (CC-BY-ND-1.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nd.svg',
  },
  'http://creativecommons.org/licenses/by-nc-sa/3.0/de/': {
    text: 'Creative Commons Attribution Non Commercial Share Alike 3.0 Germany (CC-BY-NC-SA-3.0-DE)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-sa.svg',
  },
  'http://creativecommons.org/licenses/by-nc-sa/1.0/': {
    text: 'Creative Commons Attribution Non Commercial Share Alike 1.0 Generic (CC-BY-NC-SA-1.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-sa.svg',
  },
  'http://creativecommons.org/licenses/by-nd/4.0/': {
    text: 'Creative Commons Attribution No Derivatives 4.0 International (CC-BY-ND-4.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nd.svg',
  },
  'http://creativecommons.org/licenses/by-sa/3.0/at/': {
    text: 'Creative Commons Attribution Share Alike 3.0 Austria (CC-BY-SA-3.0-AT)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-sa.svg',
  },
  'http://creativecommons.org/licenses/by/3.0/at/': {
    text: 'Creative Commons Attribution 3.0 Austria (CC-BY-3.0-AT)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by.svg',
  },
  'http://creativecommons.org/licenses/by/3.0/': {
    text: 'Creative Commons Attribution 3.0 Unported (CC-BY-3.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by.svg',
  },
  'http://creativecommons.org/licenses/by-nc/2.0/': {
    text: 'Creative Commons Attribution Non Commercial 2.0 Generic (CC-BY-NC-2.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc.svg',
  },
  'http://creativecommons.org/licenses/by-nc-sa/2.5/': {
    text: 'Creative Commons Attribution Non Commercial Share Alike 2.5 Generic (CC-BY-NC-SA-2.5)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-sa.svg',
  },
  'http://creativecommons.org/licenses/by-nc/2.5/': {
    text: 'Creative Commons Attribution Non Commercial 2.5 Generic (CC-BY-NC-2.5)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc.svg',
  },
  'http://creativecommons.org/licenses/by-nd-nc/1.0/': {
    text: 'Creative Commons Attribution Non Commercial No Derivatives 1.0 Generic (CC-BY-NC-ND-1.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-nd.svg',
  },
  'http://creativecommons.org/licenses/by-nd/3.0/': {
    text: 'Creative Commons Attribution No Derivatives 3.0 Unported (CC-BY-ND-3.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nd.svg',
  },
  'http://creativecommons.org/licenses/by-sa/2.5/': {
    text: 'Creative Commons Attribution Share Alike 2.5 Generic (CC-BY-SA-2.5)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-sa.svg',
  },
  'http://creativecommons.org/licenses/by-nc-sa/2.0/uk/': {
    text: 'Creative Commons Attribution Non Commercial Share Alike 2.0 England and Wales (CC-BY-NC-SA-2.0-UK)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-sa.svg',
  },
  'http://creativecommons.org/licenses/by/2.0/': {
    text: 'Creative Commons Attribution 2.0 Generic (CC-BY-2.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by.svg',
  },
  'http://creativecommons.org/licenses/by-nd/2.5/': {
    text: 'Creative Commons Attribution No Derivatives 2.5 Generic (CC-BY-ND-2.5)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nd.svg',
  },
  'http://creativecommons.org/licenses/by-nc-nd/2.0/': {
    text: 'Creative Commons Attribution Non Commercial No Derivatives 2.0 Generic (CC-BY-NC-ND-2.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-nd.svg',
  },
  'http://creativecommons.org/licenses/by-nc-sa/3.0/igo/': {
    text: 'Creative Commons Attribution Non Commercial Share Alike 3.0 IGO (CC-BY-NC-SA-3.0-IGO)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-sa.svg',
  },
  'http://creativecommons.org/licenses/publicdomain//': {
    text: 'Creative Commons Public Domain Dedication and Certification (CC-PDDC)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/publicdomain.svg',
  },
  'http://creativecommons.org/licenses/by-nc-sa/2.0/': {
    text: 'Creative Commons Attribution Non Commercial Share Alike 2.0 Generic (CC-BY-NC-SA-2.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-sa.svg',
  },
  'http://creativecommons.org/licenses/by-nc-nd/3.0/de/': {
    text: 'Creative Commons Attribution Non Commercial No Derivatives 3.0 Germany (CC-BY-NC-ND-3.0-DE)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-nd.svg',
  },
  'http://creativecommons.org/licenses/by-nc/3.0/': {
    text: 'Creative Commons Attribution Non Commercial 3.0 Unported (CC-BY-NC-3.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc.svg',
  },
  'http://creativecommons.org/licenses/by-nc/3.0/de/': {
    text: 'Creative Commons Attribution Non Commercial 3.0 Germany (CC-BY-NC-3.0-DE)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc.svg',
  },
  'http://creativecommons.org/licenses/by-sa/1.0/': {
    text: 'Creative Commons Attribution Share Alike 1.0 Generic (CC-BY-SA-1.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-sa.svg',
  },
  'http://creativecommons.org/licenses/by-nd/3.0/de/': {
    text: 'Creative Commons Attribution No Derivatives 3.0 Germany (CC-BY-ND-3.0-DE)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nd.svg',
  },
  'http://creativecommons.org/licenses/by-nc-nd/2.5/': {
    text: 'Creative Commons Attribution Non Commercial No Derivatives 2.5 Generic (CC-BY-NC-ND-2.5)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-nd.svg',
  },
  'http://creativecommons.org/licenses/by-sa/3.0/': {
    text: 'Creative Commons Attribution Share Alike 3.0 Unported (CC-BY-SA-3.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-sa.svg',
  },
  'http://creativecommons.org/licenses/by-nc-sa/4.0/': {
    text: 'Creative Commons Attribution Non Commercial Share Alike 4.0 International (CC-BY-NC-SA-4.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-sa.svg',
  },
  'http://creativecommons.org/licenses/by-sa/2.0/': {
    text: 'Creative Commons Attribution Share Alike 2.0 Generic (CC-BY-SA-2.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-sa.svg',
  },
  'http://creativecommons.org/licenses/by-sa/2.1/jp/': {
    text: 'Creative Commons Attribution Share Alike 2.1 Japan (CC-BY-SA-2.1-JP)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-sa.svg',
  },
  'http://creativecommons.org/licenses/by/2.5/': {
    text: 'Creative Commons Attribution 2.5 Generic (CC-BY-2.5)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by.svg',
  },
  'http://creativecommons.org/licenses/by-sa/2.0/uk/': {
    text: 'Creative Commons Attribution Share Alike 2.0 England and Wales (CC-BY-SA-2.0-UK)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-sa.svg',
  },
  'http://creativecommons.org/licenses/by/3.0/nl/': {
    text: 'Creative Commons Attribution 3.0 Netherlands (CC-BY-3.0-NL)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by.svg',
  },
  'http://creativecommons.org/licenses/by-nc-sa/3.0/': {
    text: 'Creative Commons Attribution Non Commercial Share Alike 3.0 Unported (CC-BY-NC-SA-3.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-sa.svg',
  },
  'http://creativecommons.org/licenses/by/4.0/': {
    text: 'Creative Commons Attribution 4.0 International (CC-BY-4.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by.svg',
  },
  'http://creativecommons.org/licenses/by/3.0/us/': {
    text: 'Creative Commons Attribution 3.0 United States (CC-BY-3.0-US)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by.svg',
  },
  'http://creativecommons.org/licenses/by-nc-nd/4.0/': {
    text: 'Creative Commons Attribution Non Commercial No Derivatives 4.0 International (CC-BY-NC-ND-4.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-nd.svg',
  },
  'http://creativecommons.org/licenses/by-sa/3.0/de/': {
    text: 'Creative Commons Attribution Share Alike 3.0 Germany (CC-BY-SA-3.0-DE)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-sa.svg',
  },
  'http://creativecommons.org/licenses/by-nc-nd/3.0/igo/': {
    text: 'Creative Commons Attribution Non Commercial No Derivatives 3.0 IGO (CC-BY-NC-ND-3.0-IGO)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-nd.svg',
  },
  'http://creativecommons.org/publicdomain/zero/1.0/': {
    text: 'Creative Commons Zero v1.0 Universal (CC0-1.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/cc-zero.svg',
  },
  'http://creativecommons.org/publicdomain/mark/1.0/': {
    text: 'Public Domain Mark 1.0: No Copyright',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/publicdomain.svg',
  },
  'http://creativecommons.org/licenses/by/2.5/au/': {
    text: 'Creative Commons Attribution 2.5 Australia (CC-BY-2.5-AU)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by.svg',
  },
  'http://creativecommons.org/licenses/by-nd/2.0/': {
    text: 'Creative Commons Attribution No Derivatives 2.0 Generic (CC-BY-ND-2.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nd.svg',
  },
  'http://creativecommons.org/licenses/by-nc/1.0/': {
    text: 'Creative Commons Attribution Non Commercial 1.0 Generic (CC-BY-NC-1.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc.svg',
  },
  'http://creativecommons.org/licenses/by-nc/4.0/': {
    text: 'Creative Commons Attribution Non Commercial 4.0 International (CC-BY-NC-4.0)',
    logo: 'https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc.svg',
  },
  'http://rightsstatements.org/vocab/InC/1.0/': {
    text: 'In Copyright',
    logo: 'https://rightsstatements.org/files/buttons/InC.dark.svg',
  },
  'http://rightsstatements.org/vocab/InC-OW-EU/1.0/': {
    text: 'In Copyright - EU Orphan Work',
    logo: 'https://rightsstatements.org/files/buttons/InC-OW-EU.dark.svg',
  },
  'http://rightsstatements.org/vocab/InC-EDU/1.0/': {
    text: 'In Copyright - Educational Use Permitted',
    logo: 'https://rightsstatements.org/files/buttons/InC-EDU.dark.svg',
  },
  'http://rightsstatements.org/vocab/InC-NC/1.0/': {
    text: 'In Copyright - Non-Commercial Use Permitted',
    logo: 'https://rightsstatements.org/files/buttons/InC-NC.dark.svg',
  },
  'http://rightsstatements.org/vocab/InC-RUU/1.0/': {
    text: 'In Copyright - Rights-holder(s) Unlocatable or Unidentifiable',
    logo: 'https://rightsstatements.org/files/buttons/InC-RUU.dark.svg',
  },
  'http://rightsstatements.org/vocab/NoC-CR/1.0/': {
    text: 'No Copyright - Contractual Restrictions',
    logo: 'https://rightsstatements.org/files/buttons/NoC-CR.dark.svg',
  },
  'http://rightsstatements.org/vocab/NoC-NC/1.0/': {
    text: 'No Copyright - Non-Commercial Use Only',
    logo: 'https://rightsstatements.org/files/buttons/NoC-NC.dark.svg',
  },
  'http://rightsstatements.org/vocab/NoC-OKLR/1.0/': {
    text: 'No Copyright - Other Known Legal Restrictions',
    logo: 'https://rightsstatements.org/files/buttons/NoC-OKLR.dark.svg',
  },
  'http://rightsstatements.org/vocab/NoC-US/1.0/': {
    text: 'No Copyright - United States',
    logo: 'https://rightsstatements.org/files/buttons/NoC-US.dark.svg',
  },
  'http://rightsstatements.org/vocab/CNE/1.0/': {
    text: 'Copyright Not Evaluated',
    logo: 'https://rightsstatements.org/files/buttons/CNE.dark.svg',
  },
  'http://rightsstatements.org/vocab/UND/1.0/': {
    text: 'Copyright Undetermined',
    logo: 'https://rightsstatements.org/files/buttons/UND.dark.svg',
  },
  'http://rightsstatements.org/vocab/NKC/1.0/': {
    text: 'No Known Copyright',
    logo: 'https://rightsstatements.org/files/buttons/NKC.dark.svg',
  },
};

export function getLicenseInfo(uri: string): LicenseDescription | null {
  uri = uri.replace(/^https:/, 'http:').replace(/\/deed\.[a-z]{2}$/, '');
  if (!uri.endsWith('/')) {
    uri += '/';
  }
  return licenses[uri];
}
