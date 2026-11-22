import numpy as np, pydicom, sys, zipfile, os
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid, MRImageStorage
out=sys.argv[1]; R,C,N=96,80,40
suid=generate_uid(); stuid=generate_uid()
order=list(range(N)); np.random.seed(1); np.random.shuffle(order)
for z in order:
    zz=z-N/2; yy,xx=np.mgrid[0:R,0:C]
    d=((xx-C/2)*1.0/30)**2+((yy-R/2)*1.0/38)**2+(zz*3.0/50)**2
    px=np.where(d<1,900,20).astype(np.uint16)+np.random.randint(0,30,(R,C)).astype(np.uint16)
    px[(d<0.3)]=300
    m=FileMetaDataset(); m.MediaStorageSOPClassUID=MRImageStorage; m.MediaStorageSOPInstanceUID=generate_uid(); m.TransferSyntaxUID=ExplicitVRLittleEndian
    ds=FileDataset(None,{},file_meta=m,preamble=b"\0"*128)
    ds.SOPClassUID=MRImageStorage; ds.SOPInstanceUID=m.MediaStorageSOPInstanceUID; ds.Modality='MR'
    ds.SeriesInstanceUID=suid; ds.StudyInstanceUID=stuid; ds.SeriesDescription='T1 TEST'; ds.SeriesNumber=3
    ds.Rows=R; ds.Columns=C; ds.PixelSpacing=[1.0,1.0]; ds.SliceThickness=3.0
    ds.ImagePositionPatient=[-40.0,-48.0,float(z*3.0)]; ds.ImageOrientationPatient=[1,0,0,0,1,0]; ds.InstanceNumber=z+1
    ds.SamplesPerPixel=1; ds.PhotometricInterpretation='MONOCHROME2'; ds.BitsAllocated=16; ds.BitsStored=12; ds.HighBit=11; ds.PixelRepresentation=0
    ds.PixelData=px.tobytes()
    ds.save_as(f"{out}/IM{order.index(z):04d}", enforce_file_format=True)
with zipfile.ZipFile(out+'/../scan.zip','w') as zf:
    for f in sorted(os.listdir(out)): zf.write(out+'/'+f,'DICOM/'+f)
    zf.writestr('DICOM/readme.txt','not an image')
