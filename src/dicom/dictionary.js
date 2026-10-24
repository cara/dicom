// Kleines DICOM-Wörterbuch für die Tag-Ansicht (häufige Attribute).
const RAW = `
00020000 FileMetaInformationGroupLength|00020001 FileMetaInformationVersion|00020002 MediaStorageSOPClassUID
00020003 MediaStorageSOPInstanceUID|00020010 TransferSyntaxUID|00020012 ImplementationClassUID
00020013 ImplementationVersionName|00020016 SourceApplicationEntityTitle|00080005 SpecificCharacterSet
00080008 ImageType|00080012 InstanceCreationDate|00080013 InstanceCreationTime|00080016 SOPClassUID
00080018 SOPInstanceUID|00080020 StudyDate|00080021 SeriesDate|00080022 AcquisitionDate|00080023 ContentDate
00080030 StudyTime|00080031 SeriesTime|00080032 AcquisitionTime|00080033 ContentTime|00080050 AccessionNumber
00080060 Modality|00080064 ConversionType|00080070 Manufacturer|00080080 InstitutionName
00080081 InstitutionAddress|00080090 ReferringPhysicianName|00081010 StationName|00081030 StudyDescription
0008103e SeriesDescription|00081040 InstitutionalDepartmentName|00081050 PerformingPhysicianName
00081060 NameOfPhysiciansReadingStudy|00081070 OperatorsName|00081090 ManufacturerModelName
00082144 RecommendedDisplayFrameRate|00100010 PatientName|00100020 PatientID|00100030 PatientBirthDate
00100040 PatientSex|00101010 PatientAge|00101020 PatientSize|00101030 PatientWeight|00180010 ContrastBolusAgent
00180015 BodyPartExamined|00180022 ScanOptions|00180040 CineRate|00180050 SliceThickness|00180060 KVP
00180072 EffectiveDuration|00180088 SpacingBetweenSlices|00181000 DeviceSerialNumber|00181020 SoftwareVersions
00181030 ProtocolName|00181063 FrameTime|00181065 FrameTimeVector|00181066 FrameDelay
00181088 HeartRate|00181110 DistanceSourceToDetector|00181111 DistanceSourceToPatient|00181114 EstimatedRadiographicMagnificationFactor
00181150 ExposureTime|00181151 XRayTubeCurrent|00181152 Exposure|00181155 RadiationSetting|00181160 FilterType
00181164 ImagerPixelSpacing|00181166 Grid|00181190 FocalSpots|00181242 ActualFrameDuration
00181244 PreferredPlaybackSequencing|00181500 PositionerMotion|00181510 PositionerPrimaryAngle
00181511 PositionerSecondaryAngle|00185100 PatientPosition|00186011 SequenceOfUltrasoundRegions
00186012 RegionSpatialFormat|00186014 RegionDataType|00186016 RegionFlags|00186018 RegionLocationMinX0
0018601a RegionLocationMinY0|0018601c RegionLocationMaxX1|0018601e RegionLocationMaxY1|00186024 PhysicalUnitsXDirection
00186026 PhysicalUnitsYDirection|0018602c PhysicalDeltaX|0018602e PhysicalDeltaY|00187004 DetectorType
0020000d StudyInstanceUID|0020000e SeriesInstanceUID|00200010 StudyID|00200011 SeriesNumber
00200012 AcquisitionNumber|00200013 InstanceNumber|00200020 PatientOrientation|00200032 ImagePositionPatient
00200037 ImageOrientationPatient|00200052 FrameOfReferenceUID|00200060 Laterality|00201041 SliceLocation
00204000 ImageComments|00280002 SamplesPerPixel|00280004 PhotometricInterpretation|00280006 PlanarConfiguration
00280008 NumberOfFrames|00280009 FrameIncrementPointer|00280010 Rows|00280011 Columns|00280030 PixelSpacing
00280034 PixelAspectRatio|00280100 BitsAllocated|00280101 BitsStored|00280102 HighBit|00280103 PixelRepresentation
00280106 SmallestImagePixelValue|00280107 LargestImagePixelValue|00281040 PixelIntensityRelationship
00281050 WindowCenter|00281051 WindowWidth|00281052 RescaleIntercept|00281053 RescaleSlope|00281054 RescaleType
00281055 WindowCenterWidthExplanation|00281056 VOILUTFunction|00281101 RedPaletteColorLookupTableDescriptor
00281102 GreenPaletteColorLookupTableDescriptor|00281103 BluePaletteColorLookupTableDescriptor
00281201 RedPaletteColorLookupTableData|00281202 GreenPaletteColorLookupTableData|00281203 BluePaletteColorLookupTableData
00282110 LossyImageCompression|00282112 LossyImageCompressionRatio|00282114 LossyImageCompressionMethod
00283000 ModalityLUTSequence|00283010 VOILUTSequence|00321060 RequestedProcedureDescription
00400244 PerformedProcedureStepStartDate|00400245 PerformedProcedureStepStartTime|00400254 PerformedProcedureStepDescription
00540220 ViewCodeSequence|50000010 NumberOfPoints|60000010 OverlayRows|60000011 OverlayColumns|60003000 OverlayData
7fe00008 FloatPixelData|7fe00010 PixelData|fffee000 Item`;

export const TAG_NAMES = Object.fromEntries(
  RAW.trim().split(/[|\n]/).map((s) => s.trim().split(' ')).map(([tag, name]) => [`x${tag}`, name]),
);

export function tagName(tag) {
  if (TAG_NAMES[tag]) return TAG_NAMES[tag];
  const group = parseInt(tag.slice(1, 5), 16);
  if (group % 2 === 1) return '(privat)';
  if (tag.endsWith('0000')) return 'GroupLength';
  return '';
}

export function formatTag(tag) {
  return `(${tag.slice(1, 5)},${tag.slice(5, 9)})`.toUpperCase();
}
